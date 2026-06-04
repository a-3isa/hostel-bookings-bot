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

    try:
        booking = sheets.get_booking_by_ref(ref)
        if booking is None:
            await update.message.reply_text(
                f"❌ Booking reference {ref} not found.\nTry again or /cancel:"
            )
            return CHECK_REF

        config = sheets.get_config()
        host_phone = config.get("host_phone", "")
        location_display = booking.get("location_name") or booking.get("location_id", "N/A")
        room_display = booking.get("room_number") or booking.get("room_id", "N/A")

        details = (
            f"📋 *Your Booking*\n\n"
            f"📍 {location_display}\n"
            f"🚪 Room {room_display}\n"
            f"📅 {booking.get('check_in', 'N/A')} → {booking.get('check_out', 'N/A')}\n"
            f"🕐 Arrival: {booking.get('arrival_time', 'N/A')}\n"
            f"👤 {booking.get('guest_name', 'N/A')}\n"
            f"📞 {booking.get('phone', 'N/A')}\n"
            f"🔖 Ref: {booking.get('booking_ref', ref)}\n"
        )
        if host_phone:
            details += f"📞 Host: {host_phone}\n"
        details += "\n📞 Please call the host 1 hour before your arrival time."

        await update.message.reply_text(details, parse_mode="Markdown")
        return ConversationHandler.END
    except Exception:
        await update.message.reply_text(
            "⚠️ Something went wrong. Please try again or /cancel:"
        )
        return CHECK_REF


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
