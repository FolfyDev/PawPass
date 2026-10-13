import { app, bootstrap } from './app.js';
import { env } from './lib/env.js';
import { createBot } from './bot/index.js';
import { startPaymentSweeper } from './lib/payments.js';
import { startRetentionJob } from './lib/retention.js';

bootstrap().catch((e) => {
  console.error(e.message);
  process.exit(1);
}).then(() => {
  app.listen(env.port, () => console.log(`API on :${env.port}`));
  startPaymentSweeper();
  startRetentionJob();
  const bot = createBot();
  if (bot) {

    bot
      .start({ onStart: (i) => console.log(`Telegram bot @${i.username} running`) })
      .catch((err) => console.error('Telegram bot stopped:', err.description || err.message));
  } else {
    console.log('Telegram bot disabled (no TELEGRAM_BOT_TOKEN)');
  }
});
