"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const core = __importStar(require("@actions/core"));
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const STATE_FILE = path.join(process.env.RUNNER_TEMP || '/tmp', 'soceng-tunnel-state.json');
async function run() {
    const isPost = core.getState('isPost') === 'true';
    if (isPost) {
        await cleanup();
    }
    else {
        core.saveState('isPost', 'true');
        await startTunnel();
    }
}
async function startTunnel() {
    try {
        // Parse inputs
        const port = core.getInput('port', { required: true });
        const serverHost = core.getInput('server-host') || 'abbreviated.ai';
        const serverPort = core.getInput('server-port') || '443';
        const apiToken = core.getInput('api-token');
        const subdomain = core.getInput('subdomain');
        const localHost = core.getInput('local-host') || 'localhost';
        const useLocal = core.getInput('local') === 'true';
        // Validate port
        const portNum = parseInt(port, 10);
        if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
            throw new Error(`Invalid port: ${port}. Must be a number between 1 and 65535.`);
        }
        core.info(`Starting soceng-tunnel...`);
        core.info(`  Local: ${localHost}:${port}`);
        core.info(`  Server: ${serverHost}:${serverPort}`);
        // Build CLI arguments
        const args = [
            'start-local-tunnel',
            '--port', port,
            '--local-host', localHost,
            '--server-host', serverHost,
            '--server-port', serverPort,
        ];
        if (apiToken) {
            args.push('--api-token', apiToken);
        }
        if (subdomain) {
            args.push('--subdomain', subdomain);
        }
        if (useLocal) {
            args.push('--local');
        }
        // Path to the tunnel CLI (bundled in dist/)
        const tunnelCliPath = path.join(__dirname, '..', '..', 'dist', 'index.js');
        // Spawn detached process
        const child = (0, child_process_1.spawn)('node', [tunnelCliPath, ...args], {
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        // Wait for tunnel URL from stdout
        const { tunnelUrl, tunnelId } = await waitForTunnelReady(child);
        // Unref to allow parent to exit while child continues
        child.unref();
        // Save state for cleanup
        const state = {
            pid: child.pid,
            tunnelUrl,
            tunnelId,
        };
        fs.writeFileSync(STATE_FILE, JSON.stringify(state));
        // Set outputs
        core.setOutput('tunnel-url', tunnelUrl);
        core.setOutput('tunnel-id', tunnelId);
        // Export environment variable
        core.exportVariable('TUNNEL_URL', tunnelUrl);
        core.info(`Tunnel is open!`);
        core.info(`  Public URL: ${tunnelUrl}`);
        core.info(`  Tunnel ID: ${tunnelId}`);
        core.info(`  Process PID: ${child.pid}`);
    }
    catch (error) {
        if (error instanceof Error) {
            core.setFailed(error.message);
        }
        else {
            core.setFailed('An unknown error occurred');
        }
    }
}
function waitForTunnelReady(child) {
    return new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        let resolved = false;
        const timeout = setTimeout(() => {
            if (!resolved) {
                resolved = true;
                child.kill();
                reject(new Error(`Tunnel failed to start within 30 seconds.\nStdout: ${stdout}\nStderr: ${stderr}`));
            }
        }, 30000);
        child.stdout?.on('data', (data) => {
            const chunk = data.toString();
            stdout += chunk;
            core.debug(`stdout: ${chunk}`);
            // Parse tunnel info from output
            // Expected format:
            //   Public URL: http://...
            //   Tunnel ID: ...
            const urlMatch = stdout.match(/Public URL:\s*(\S+)/);
            const idMatch = stdout.match(/Tunnel ID:\s*(\S+)/);
            if (urlMatch && idMatch && !resolved) {
                resolved = true;
                clearTimeout(timeout);
                resolve({
                    tunnelUrl: urlMatch[1],
                    tunnelId: idMatch[1],
                });
            }
        });
        child.stderr?.on('data', (data) => {
            const chunk = data.toString();
            stderr += chunk;
            core.debug(`stderr: ${chunk}`);
        });
        child.on('error', (err) => {
            if (!resolved) {
                resolved = true;
                clearTimeout(timeout);
                reject(new Error(`Failed to spawn tunnel process: ${err.message}`));
            }
        });
        child.on('exit', (code, signal) => {
            if (!resolved) {
                resolved = true;
                clearTimeout(timeout);
                reject(new Error(`Tunnel process exited unexpectedly with code ${code}, signal ${signal}.\nStdout: ${stdout}\nStderr: ${stderr}`));
            }
        });
    });
}
async function cleanup() {
    core.info('Cleaning up tunnel...');
    try {
        if (!fs.existsSync(STATE_FILE)) {
            core.info('No tunnel state file found, nothing to clean up.');
            return;
        }
        const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
        const { pid } = state;
        core.info(`Stopping tunnel process (PID: ${pid})...`);
        try {
            // Check if process is still running
            process.kill(pid, 0);
            // Send SIGTERM for graceful shutdown
            process.kill(pid, 'SIGTERM');
            // Wait a bit for graceful shutdown
            await sleep(1000);
            try {
                // Check if still running
                process.kill(pid, 0);
                // If still running, force kill
                core.info('Process still running, sending SIGKILL...');
                process.kill(pid, 'SIGKILL');
            }
            catch {
                // Process already exited, good
            }
            core.info('Tunnel process stopped.');
        }
        catch (err) {
            // Process doesn't exist (already exited)
            core.info('Tunnel process already exited.');
        }
        // Clean up state file
        fs.unlinkSync(STATE_FILE);
    }
    catch (error) {
        if (error instanceof Error) {
            core.warning(`Cleanup error: ${error.message}`);
        }
    }
}
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
run();
//# sourceMappingURL=main.js.map