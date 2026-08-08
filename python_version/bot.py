import logging
from telegram import Update
from telegram.ext import Application
import config
from handlers.booking import build_booking_handler

logging.basicConfig(
    format="%(asctime)s — %(name)s — %(levelname)s — %(message)s",
    level=logging.INFO,
)


def main() -> None:
    app = Application.builder().token(config.BOT_TOKEN).build()
    # Single purpose: /start launches the receptionist booking-entry flow.
    app.add_handler(build_booking_handler())
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    import asyncio
    asyncio.set_event_loop(asyncio.new_event_loop())
    main()
