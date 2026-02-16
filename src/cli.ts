import { program } from 'commander';
import { runSetup } from './commands/setup.js';
import { runStatus } from './commands/status.js';
import { runFund } from './commands/fund.js';

program
  .name('signal402')
  .description('CLI for x402 payments — set up a wallet, fund it, and start paying for queries')
  .version('0.2.0');

program
  .command('setup')
  .description('Set up wallet + gas + USDC funding + signing session')
  .action(runSetup);

program
  .command('status')
  .description('Show wallet address, USDC balance, and session status')
  .action(runStatus);

program
  .command('fund')
  .description('Fund your wallet with USDC on Base')
  .action(runFund);

program.parse();
