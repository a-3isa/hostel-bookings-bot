import logging
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import Application, CommandHandler
import config
from handlers.booking import build_booking_handler
from handlers.check_booking import build_check_handler
from handlers import admin

logging.basicConfig(
    format="%(asctime)s — %(name)s — %(levelname)s — %(message)s",
    level=logging.INFO,
)


async def start(update: Update, context) -> None:
    keyboard = [
        [InlineKeyboardButton("📅 New Booking",      callback_data="new_booking")],
        [InlineKeyboardButton("🔍 Check My Booking", callback_data="check_booking")],
    ]
    await update.effective_message.reply_text(
        "👋 Welcome! What would you like to do?",
        reply_markup=InlineKeyboardMarkup(keyboard),
    )


def main() -> None:
    app = Application.builder().token(config.BOT_TOKEN).build()

    app.add_handler(CommandHandler("start", start))
    app.add_handler(build_booking_handler())
    app.add_handler(build_check_handler())
    app.add_handler(CommandHandler("set_available",   admin.set_available))
    app.add_handler(CommandHandler("set_unavailable", admin.set_unavailable))
    app.add_handler(CommandHandler("add_room",        admin.add_room))
    app.add_handler(CommandHandler("remove_room",     admin.remove_room))
    app.add_handler(CommandHandler("list_rooms",      admin.list_rooms))
    app.add_handler(CommandHandler("upload_photo",    admin.upload_photo))

    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
