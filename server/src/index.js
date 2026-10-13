import { app, bootstrap } from './app.js';
import { env } from './lib/env.js';
import { createBot } from './bot/index.js';
import { startPaymentSweeper } from './lib/payments.js';
import { startRetentionJob } from './lib/retention.js';
import { setBotStatus } from './lib/botStatus.js';

bootstrap().catch((e) => {
  console.error(e.message);
  process.exit(1);
}).then(() => {
  app.listen(env.port, () => console.log(`API on :${env.port}`));
  startPaymentSweeper();
  startRetentionJob();
  const bot = createBot();
  if (bot) {
    setBotStatus('starting');
    bot
      .start({ onStart: (i) => { setBotStatus('running', { username: i.username }); console.log(`Telegram bot @${i.username} running`); } })
      .catch((err) => {
        const why = err.description || err.message;
        setBotStatus('stopped', { error: why });
        console.error('Telegram bot stopped:', why);
      });
  } else {
    console.log('Telegram bot disabled (no TELEGRAM_BOT_TOKEN)');
  }
});
