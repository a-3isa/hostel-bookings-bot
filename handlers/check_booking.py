from telegram import Update
from telegram.ext import (
    ContextTypes,
    ConversationHandler,
    CallbackQueryHandler,
    MessageHandler,
    CommandHandler,
    filters,
)
import sheets
from utils.validators import validate_booking_ref

CHECK_REF = 0


async def start_check(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()
    await query.message.reply_text(
        "🔍 Please enter your booking reference:\n(e.g. BK-000042)\n\nType /cancel to exit."
    )
    return CHECK_REF


async def handle_ref(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    ref = validate_booking_ref(update.message.text)
    if ref is None:
        await update.message.reply_text(
            "❌ Invalid format. Expected: BK-XXXXXX\nTry again or /cancel:"
        )
        return CHECK_REF

    booking = sheets.get_booking_by_ref(ref)
    if booking is None:
        await update.message.reply_text(
            f"❌ Booking reference {ref} not found.\nTry again or /cancel:"
        )
        return CHECK_REF

    config = sheets.get_config()
    host_phone = config.get("host_phone", "")
    location_display = booking.get("location_name") or booking.get("location_id", "")
    room_display = booking.get("room_number") or booking.get("room_id", "")

    details = (
        f"📋 *Your Booking*\n\n"
        f"📍 {location_display}\n"
        f"🚪 Room {room_display}\n"
        f"📅 {booking['check_in']} → {booking['check_out']}\n"
        f"🕐 Arrival: {booking['arrival_time']}\n"
        f"👤 {booking['guest_name']}\n"
        f"📞 {booking['phone']}\n"
        f"🔖 Ref: {booking['booking_ref']}\n"
        f"📞 Host: {host_phone}\n\n"
        f"📞 Please call the host 1 hour before your arrival time."
    )
    await update.message.reply_text(details, parse_mode="Markdown")
    return ConversationHandler.END


async def cancel(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    await update.effective_message.reply_text("Cancelled. Send /start to begin again.")
    return ConversationHandler.END


def build_check_handler() -> ConversationHandler:
    return ConversationHandler(
        entry_points=[CallbackQueryHandler(start_check, pattern="^check_booking$")],
        states={
            CHECK_REF: [MessageHandler(filters.TEXT & ~filters.COMMAND, handle_ref)],
        },
        fallbacks=[
            CommandHandler("cancel", cancel),
            CommandHandler("start",  cancel),
        ],
        allow_reentry=True,
    )
