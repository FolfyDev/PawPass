import { app, bootstrap } from './app.js';
import { env } from './lib/env.js';
import { createBot } from './bot/index.js';
import { startPaymentSweeper } from './lib/payments.js';

bootstrap().then(() => {
  app.listen(env.port, () => console.log(`API on :${env.port}`));
  startPaymentSweeper();
  const bot = createBot();
  if (bot) {
    bot.start({ onStart: (i) => console.log(`Telegram bot @${i.username} running`) });
  } else {
    console.log('Telegram bot disabled (no TELEGRAM_BOT_TOKEN)');
  }
});
