#!/usr/bin/env node

// MUST be first: raises the libuv threadpool size before any fs work is
// submitted. See src/bootstrap.ts for why import order matters.
import './bootstrap.js';
import { FilteredStdioServerTransport } from './custom-stdio.js';
import { server, flushDeferredMessages } from './server.js';
import { commandManager } from './command-manager.js';
import { configManager } from './config-manager.js';
import { SELF_HOSTED_ENGINE, SELF_HOSTED_WORKSPACE } from './config.js';
import path from 'node:path';
import { featureFlagManager } from './utils/feature-flags.js';
import { runSetup } from './npm-scripts/setup.js';
import { runUninstall } from './npm-scripts/uninstall.js';
import { capture } from './utils/capture.js';
import { logToStderr, logger } from './utils/logger.js';
import { exitProcess } from './utils/exit-process.js';
import { runRemote } from './npm-scripts/remote.js';
import { ensureChromeAvailable } from './tools/pdf/markdown.js';
import { preloadFileSupport } from './utils/files/index.js';
import { terminalManager } from './terminal-manager.js';
import { searchManager } from './search-manager.js';
import { toolHistory } from './utils/toolHistory.js';
import { MAX_MESSAGE_BYTES } from './self-host/protocol.js';

// Store messages to defer until after initialization
const deferredMessages: Array<{ level: string, message: string }> = [];
function deferLog(level: string, message: string) {
  deferredMessages.push({ level, message });
}

async function runServer() {
  try {
    // Check if first argument is "setup"
    if (process.argv[2] === 'setup') {
      await runSetup();
      return;
    }

    // Check if first argument is "remove"
    if (process.argv[2] === 'remove') {
      await runUninstall();
      return;
    }

    // Check if first argument is "remote"
    if (process.argv[2] === 'remote') {
      await runRemote();
      return;
    }

    // Parse command line arguments for onboarding control
    const DISABLE_ONBOARDING = process.env.JRC_SELF_HOSTED === '1' || process.argv.includes('--no-onboarding');
    if (DISABLE_ONBOARDING) {
      logToStderr('info', 'Onboarding disabled via --no-onboarding flag');
    }

    // Set global flag for onboarding control
    (global as any).disableOnboarding = DISABLE_ONBOARDING;

    // Create transport FIRST so all logging gets properly buffered
    // This must happen before any code that might use logger.*
    const transport = new FilteredStdioServerTransport(process.env.JRC_SELF_HOSTED === '1' ? MAX_MESSAGE_BYTES - 1024 : undefined);

    // Export transport for use throughout the application
    global.mcpTransport = transport;

    try {
      deferLog('info', 'Loading configuration...');
      await configManager.loadConfig();
      if (SELF_HOSTED_ENGINE) {
        if (!SELF_HOSTED_WORKSPACE || !path.isAbsolute(SELF_HOSTED_WORKSPACE)) {
          throw new Error('Self-hosted engine requires an absolute workspace.');
        }
        await configManager.setValue('telemetryEnabled', false);
      }
      deferLog('info', 'Configuration loaded successfully');

      // Initialize feature flags (non-blocking)
      deferLog('info', 'Initializing feature flags...');
      await featureFlagManager.initialize();
    } catch (configError) {
      // A remote engine must never continue with missing access configuration.
      if (process.env.JRC_SELF_HOSTED === '1') throw configError;
      deferLog('error', `Failed to load configuration: ${configError instanceof Error ? configError.message : String(configError)}`);
      if (configError instanceof Error && configError.stack) {
        deferLog('debug', `Stack trace: ${configError.stack}`);
      }
      deferLog('warning', 'Continuing with in-memory configuration only');
      // Continue anyway - we'll use an in-memory config
    }

    // Handle uncaught exceptions
    process.on('uncaughtException', async (error) => {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // If this is a JSON parsing error, log it to stderr but don't crash
      if (errorMessage.includes('JSON') && errorMessage.includes('Unexpected token')) {
        logger.error(`JSON parsing error: ${errorMessage}`);
        return; // Don't exit on JSON parsing errors
      }

      capture('run_server_uncaught_exception', {
        error: errorMessage
      });

      logger.error(`Uncaught exception: ${errorMessage}`);
      exitProcess(1);
    });

    // Handle unhandled rejections: log and keep serving. The code that created
    // the promise has already moved on (often a library's detached cleanup, as
    // with puppeteer's profile removal), so the server's state is intact, and
    // exiting would drop every running process, session and search.
    process.on('unhandledRejection', async (reason) => {
      const errorMessage = reason instanceof Error ? reason.message : String(reason);

      // A JSON parsing error is logged as before, and not sent to telemetry
      if (errorMessage.includes('JSON') && errorMessage.includes('Unexpected token')) {
        logger.error(`JSON parsing rejection: ${errorMessage}`);
        return;
      }

      capture('run_server_unhandled_rejection', {
        error: errorMessage
      });

      logger.error(`Unhandled rejection: ${errorMessage}`);
    });

    capture('run_server_start');

    deferLog('info', 'Connecting server...');

    // Set up event-driven initialization completion handler
    server.oninitialized = () => {
      // This callback is triggered after the client sends the "initialized" notification
      // At this point, the MCP protocol handshake is fully complete
      transport.enableNotifications();

      // Flush all deferred messages from both index.ts and server.ts
      while (deferredMessages.length > 0) {
        const msg = deferredMessages.shift()!;
        transport.sendLog('info', msg.message);
      }
      flushDeferredMessages();

      // Now we can send regular logging messages
      transport.sendLog('info', 'Server connected successfully');
      transport.sendLog('info', 'MCP fully initialized, all startup messages sent');

      // Preemptively check/download Chrome for PDF generation (runs in background)
      if (process.env.JRC_SELF_HOSTED !== '1') ensureChromeAvailable();

      // Load the Excel, DOCX and PDF packages, one at a time, now that initialize
      // has been answered; until then the calls that need them answer at once
      if (process.env.JRC_SELF_HOSTED !== '1') preloadFileSupport();
    };

    if (process.env.JRC_SELF_HOSTED === '1') {
      let closing = false;
      const stop = async () => {
        if (closing) return;
        closing = true;
        searchManager.dispose();
        featureFlagManager.destroy();
        await Promise.allSettled(terminalManager.listActiveSessions().map(({pid}) => terminalManager.forceTerminate(pid)));
        await toolHistory.cleanup();
        await server.close();
        exitProcess(0);
      };
      process.stdin.once('end', () => { void stop(); });
      process.once('SIGTERM', () => { void stop(); });
      process.once('SIGINT', () => { void stop(); });
    }
    await server.connect(transport);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`FATAL ERROR: ${errorMessage}`);
    if (error instanceof Error && error.stack) {
      logger.debug(error.stack);
    }

    // Send a structured error notification
    const errorNotification = {
      jsonrpc: "2.0" as const,
      method: "notifications/message",
      params: {
        level: "error",
        logger: "desktop-commander",
        data: `Failed to start server: ${errorMessage} (${new Date().toISOString()})`
      }
    };
    process.stdout.write(JSON.stringify(errorNotification) + '\n');

    capture('run_server_failed_start_error', {
      error: errorMessage
    });
    exitProcess(1);
  }
}

runServer().catch(async (error) => {
  const errorMessage = error instanceof Error ? error.message : String(error);
  console.error(`RUNTIME ERROR: ${errorMessage}`);
  console.error(error instanceof Error && error.stack ? error.stack : 'No stack trace available');
  process.stderr.write(JSON.stringify({
    type: 'error',
    timestamp: new Date().toISOString(),
    message: `Fatal error running server: ${errorMessage}`
  }) + '\n');


  capture('run_server_fatal_error', {
    error: errorMessage
  });
  exitProcess(1);
});
