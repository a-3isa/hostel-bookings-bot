from datetime import date as dt_date
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup, InputMediaPhoto
from telegram.ext import (
    ContextTypes,
    ConversationHandler,
    CallbackQueryHandler,
    MessageHandler,
    CommandHandler,
    filters,
)
import sheets
from utils.validators import (
    validate_date,
    validate_checkout_date,
    validate_name,
    validate_phone,
    validate_time,
)
from utils.ref_generator import format_ref

(
    RULES, LOCATION, ROOM, PHOTOS,
    CHECK_IN, CHECK_OUT, NAME, PHONE, ARRIVAL,
    CONFIRM, EDIT_MENU, EDIT_FIELD,
) = range(12)


async def show_rules(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()
    config = sheets.get_config()
    rules_text = config.get("rules", "Please respect the property and other guests.")
    keyboard = [
        [InlineKeyboardButton("✅ I Agree — Continue", callback_data="rules_agree")],
        [InlineKeyboardButton("❌ I Disagree — Exit", callback_data="rules_disagree")],
    ]
    await query.edit_message_text(
        f"📋 *Booking Rules*\n\n{rules_text}\n\nPlease read before proceeding.",
        parse_mode="Markdown",
        reply_markup=InlineKeyboardMarkup(keyboard),
    )
    return RULES


async def handle_rules(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()
    if query.data == "rules_disagree":
        await query.edit_message_text("No problem! Send /start to begin again.")
        return ConversationHandler.END
    return await _show_locations(update, context)


async def _show_locations(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    locations = sheets.get_locations()
    keyboard = [
        [InlineKeyboardButton(f"📍 {loc['name']}", callback_data=f"loc_{loc['location_id']}")]
        for loc in locations
    ]
    text = "🏙️ Choose a location:"
    if update.callback_query:
        await update.callback_query.edit_message_text(text, reply_markup=InlineKeyboardMarkup(keyboard))
    else:
        await update.effective_message.reply_text(text, reply_markup=InlineKeyboardMarkup(keyboard))
    return LOCATION


async def handle_location(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()
    location_id = query.data[4:]
    locations = sheets.get_locations()
    location = next((loc for loc in locations if loc["location_id"] == location_id), None)
    if location is None:
        await query.message.reply_text(
            "⚠️ This location is no longer available. Please start again."
        )
        return await _show_locations(update, context)
    context.user_data.update({
        "location_id": location_id,
        "location_name": location["name"],
    })
    context.user_data.pop("room_id", None)
    context.user_data.pop("room_number", None)
    context.user_data.pop("photo_file_ids", None)
    return await _show_rooms(update, context)


async def _show_rooms(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    location_id = context.user_data["location_id"]
    rooms = sheets.get_available_rooms(location_id)
    if not rooms:
        keyboard = [[InlineKeyboardButton("⬅️ Back to locations", callback_data="rooms_back")]]
        text = "😔 No rooms available at this location right now."
        if update.callback_query:
            await update.callback_query.edit_message_text(text, reply_markup=InlineKeyboardMarkup(keyboard))
        else:
            await update.effective_message.reply_text(text, reply_markup=InlineKeyboardMarkup(keyboard))
        return ROOM
    keyboard = [
        [InlineKeyboardButton(f"🚪 Room {r['room_number']}", callback_data=f"room_{r['room_id']}")]
        for r in rooms
    ]
    keyboard.append([InlineKeyboardButton("⬅️ Back to locations", callback_data="rooms_back")])
    text = f"🚪 Available rooms at *{context.user_data['location_name']}*:"
    if update.callback_query:
        await update.callback_query.edit_message_text(text, parse_mode="Markdown", reply_markup=InlineKeyboardMarkup(keyboard))
    else:
        await update.effective_message.reply_text(text, parse_mode="Markdown", reply_markup=InlineKeyboardMarkup(keyboard))
    return ROOM


async def handle_room(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()
    if query.data == "rooms_back":
        return await _show_locations(update, context)
    room_id = query.data[5:]
    room = sheets.get_room(room_id)
    if room is None:
        await query.message.reply_text(
            "⚠️ This room is no longer available. Please choose another."
        )
        return await _show_rooms(update, context)
    context.user_data["room_id"] = room_id
    context.user_data["room_number"] = room["room_number"]
    photo_ids = [p.strip() for p in room["photo_file_ids"].split(",") if p.strip()]
    context.user_data["photo_file_ids"] = photo_ids
    return await _show_photos(update, context)


async def _show_photos(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    photo_ids = context.user_data["photo_file_ids"]
    keyboard = [
        [InlineKeyboardButton("✅ Yes, continue", callback_data="photos_yes")],
        [InlineKeyboardButton("⬅️ Back to rooms", callback_data="photos_back")],
    ]
    if photo_ids:
        media = [InputMediaPhoto(pid) for pid in photo_ids[:10]]
        msg = update.callback_query.message if update.callback_query else update.effective_message
        await msg.reply_media_group(media)
        await msg.reply_text(
            "Does this room work for you?",
            reply_markup=InlineKeyboardMarkup(keyboard),
        )
    else:
        text = "📷 No photos available for this room.\n\nDoes this room work for you?"
        if update.callback_query:
            await update.callback_query.edit_message_text(text, reply_markup=InlineKeyboardMarkup(keyboard))
        else:
            await update.effective_message.reply_text(text, reply_markup=InlineKeyboardMarkup(keyboard))
    return PHOTOS


async def handle_photos(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()
    if query.data == "photos_back":
        return await _show_rooms(update, context)
    if context.user_data.pop("editing", False):
        return await _show_confirm(update, context)
    await query.message.reply_text("📅 Enter check-in date:\nFormat: DD/MM/YYYY")
    return CHECK_IN


async def handle_check_in(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    result = validate_date(update.message.text)
    if result is None:
        await update.message.reply_text(
            "❌ Invalid date. Must be today or later, format DD/MM/YYYY.\nTry again:"
        )
        return CHECK_IN
    context.user_data["check_in"] = update.message.text.strip()
    context.user_data["check_in_date"] = result
    await update.message.reply_text(
        "📅 Enter check-out date:\nFormat: DD/MM/YYYY (must be after check-in)"
    )
    return CHECK_OUT


async def handle_check_out(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    result = validate_checkout_date(update.message.text, context.user_data["check_in_date"])
    if result is None:
        await update.message.reply_text(
            f"❌ Date must be strictly after check-in ({context.user_data['check_in']}).\nTry again:"
        )
        return CHECK_OUT
    context.user_data["check_out"] = update.message.text.strip()
    await update.message.reply_text("👤 Enter your full name:")
    return NAME


async def handle_name(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    result = validate_name(update.message.text)
    if result is None:
        await update.message.reply_text(
            "❌ Letters and spaces only, minimum 3 characters.\nTry again:"
        )
        return NAME
    context.user_data["guest_name"] = result
    await update.message.reply_text("📞 Enter your phone number:")
    return PHONE


async def handle_phone(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    result = validate_phone(update.message.text)
    if result is None:
        await update.message.reply_text(
            "❌ Digits only (optional leading +), minimum 7 digits.\nTry again:"
        )
        return PHONE
    context.user_data["phone"] = result
    await update.message.reply_text("🕐 What time will you arrive? (HH:MM, e.g. 14:00)")
    return ARRIVAL


async def handle_arrival(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    result = validate_time(update.message.text)
    if result is None:
        await update.message.reply_text(
            "❌ Invalid time. Use HH:MM format (e.g. 14:00).\nTry again:"
        )
        return ARRIVAL
    context.user_data["arrival_time"] = result
    return await _show_confirm(update, context)


async def _show_confirm(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    d = context.user_data
    summary = (
        f"📋 *Please review your booking:*\n\n"
        f"📍 {d['location_name']}\n"
        f"🚪 Room {d['room_number']}\n"
        f"📅 {d['check_in']} → {d['check_out']}\n"
        f"🕐 Arrival: {d['arrival_time']}\n"
        f"👤 {d['guest_name']}\n"
        f"📞 {d['phone']}"
    )
    keyboard = [
        [InlineKeyboardButton("✅ Agree", callback_data="confirm_agree")],
        [InlineKeyboardButton("✏️ Change something", callback_data="confirm_change")],
        [InlineKeyboardButton("❌ Cancel", callback_data="confirm_cancel")],
    ]
    await update.effective_message.reply_text(
        summary, parse_mode="Markdown", reply_markup=InlineKeyboardMarkup(keyboard)
    )
    return CONFIRM


async def handle_confirm(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()
    if query.data == "confirm_cancel":
        await query.edit_message_text("Booking cancelled. Send /start to begin again.")
        return ConversationHandler.END
    if query.data == "confirm_change":
        return await _show_edit_menu(update, context)

    # confirm_agree — save booking
    try:
        config = sheets.get_config()
        d = context.user_data

        counter = sheets.increment_booking_counter()
        ref = format_ref(counter)

        booking_data = {
            "booking_ref": ref,
            "room_id": d["room_id"],
            "room_number": d["room_number"],
            "location_id": d["location_id"],
            "location_name": d["location_name"],
            "check_in": d["check_in"],
            "check_out": d["check_out"],
            "arrival_time": d["arrival_time"],
            "guest_name": d["guest_name"],
            "phone": d["phone"],
            "telegram_id": update.effective_user.id,
            "created_at": str(dt_date.today()),
        }
        sheets.append_booking(booking_data)
        sheets.set_room_availability(d["room_id"], False)

        host_chat_id = config.get("host_chat_id", "")
        if host_chat_id:
            host_msg = (
                f"🔔 *New Booking Confirmed*\n\n"
                f"🔖 Ref: {ref}\n"
                f"📍 Location: {d['location_name']}\n"
                f"🚪 Room: {d['room_number']}\n"
                f"📅 Check-in: {d['check_in']}\n"
                f"📅 Check-out: {d['check_out']}\n"
                f"🕐 Arrival: {d['arrival_time']}\n"
                f"👤 Guest: {d['guest_name']}\n"
                f"📞 Phone: {d['phone']}\n"
                f"🤖 Telegram ID: {update.effective_user.id}"
            )
            try:
                await context.bot.send_message(
                    chat_id=int(host_chat_id), text=host_msg, parse_mode="Markdown"
                )
            except Exception:
                pass  # notification failure must not block confirmation message

        host_phone = config.get("host_phone", "")
        await query.edit_message_text(
            f"🎉 *Your booking is confirmed!*\n"
            f"🔖 Reference: *{ref}*\n"
            f"📞 Host: {host_phone}\n\n"
            f"📞 Please call the host 1 hour before your arrival time.",
            parse_mode="Markdown",
        )
        return ConversationHandler.END
    except Exception:
        await query.message.reply_text(
            "⚠️ Something went wrong saving your booking. Please try again."
        )
        return CONFIRM


async def _show_edit_menu(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    keyboard = [
        [InlineKeyboardButton("📅 Check-in date",  callback_data="edit_check_in")],
        [InlineKeyboardButton("📅 Check-out date", callback_data="edit_check_out")],
        [InlineKeyboardButton("🕐 Arrival time",   callback_data="edit_arrival")],
        [InlineKeyboardButton("👤 Name",            callback_data="edit_name")],
        [InlineKeyboardButton("📞 Phone",           callback_data="edit_phone")],
        [InlineKeyboardButton("🚪 Room",            callback_data="edit_room")],
        [InlineKeyboardButton("📍 Location",        callback_data="edit_location")],
    ]
    await update.callback_query.edit_message_text(
        "✏️ What would you like to change?",
        reply_markup=InlineKeyboardMarkup(keyboard),
    )
    return EDIT_MENU


async def handle_edit_menu(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()
    target = query.data[5:]  # strip "edit_"

    if target == "location":
        for key in ("location_id", "location_name", "room_id", "room_number", "photo_file_ids"):
            context.user_data.pop(key, None)
        context.user_data["editing"] = True
        return await _show_locations(update, context)

    if target == "room":
        for key in ("room_id", "room_number", "photo_file_ids"):
            context.user_data.pop(key, None)
        context.user_data["editing"] = True
        return await _show_rooms(update, context)

    prompts = {
        "check_in":  "📅 Enter new check-in date (DD/MM/YYYY):",
        "check_out": f"📅 Enter new check-out date (DD/MM/YYYY, after {context.user_data.get('check_in', 'check-in')}):",
        "name":      "👤 Enter your new full name:",
        "phone":     "📞 Enter your new phone number:",
        "arrival":   "🕐 Enter new arrival time (HH:MM, e.g. 14:00):",
    }
    context.user_data["edit_target"] = target
    await query.message.reply_text(prompts[target])
    return EDIT_FIELD


async def handle_edit_field(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    target = context.user_data["edit_target"]
    text = update.message.text

    validator_map = {
        "check_in":  lambda t: validate_date(t),
        "check_out": lambda t: validate_checkout_date(t, context.user_data.get("check_in_date")),
        "name":      validate_name,
        "phone":     validate_phone,
        "arrival":   validate_time,
    }
    error_map = {
        "check_in":  "❌ Invalid date. Use DD/MM/YYYY and not in the past.",
        "check_out": f"❌ Must be strictly after check-in ({context.user_data.get('check_in', '')}).",
        "name":      "❌ Letters and spaces only, min 3 characters.",
        "phone":     "❌ Digits only (optional leading +), min 7 digits.",
        "arrival":   "❌ Use HH:MM format (e.g. 14:00).",
    }
    field_key_map = {
        "check_in":  "check_in",
        "check_out": "check_out",
        "name":      "guest_name",
        "phone":     "phone",
        "arrival":   "arrival_time",
    }

    result = validator_map[target](text)
    if result is None:
        await update.message.reply_text(f"{error_map[target]}\nTry again:")
        return EDIT_FIELD

    if target == "check_in":
        context.user_data["check_in"] = text.strip()
        context.user_data["check_in_date"] = result
        context.user_data.pop("check_out", None)
        context.user_data.pop("edit_target", None)
        await update.message.reply_text(
            f"📅 Check-in updated to {text.strip()}.\n"
            f"Now enter your new check-out date (DD/MM/YYYY, must be after {text.strip()}):"
        )
        return CHECK_OUT
    else:
        context.user_data[field_key_map[target]] = result

    context.user_data.pop("edit_target", None)
    return await _show_confirm(update, context)


async def cancel(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    await update.effective_message.reply_text("Cancelled. Send /start to begin again.")
    return ConversationHandler.END


def build_booking_handler() -> ConversationHandler:
    return ConversationHandler(
        entry_points=[CallbackQueryHandler(show_rules, pattern="^new_booking$")],
        states={
            RULES:      [CallbackQueryHandler(handle_rules,     pattern="^rules_(agree|disagree)$")],
            LOCATION:   [CallbackQueryHandler(handle_location,  pattern="^loc_")],
            ROOM:       [CallbackQueryHandler(handle_room,      pattern="^room_|^rooms_back$")],
            PHOTOS:     [CallbackQueryHandler(handle_photos,    pattern="^photos_(yes|back)$")],
            CHECK_IN:   [MessageHandler(filters.TEXT & ~filters.COMMAND, handle_check_in)],
            CHECK_OUT:  [MessageHandler(filters.TEXT & ~filters.COMMAND, handle_check_out)],
            NAME:       [MessageHandler(filters.TEXT & ~filters.COMMAND, handle_name)],
            PHONE:      [MessageHandler(filters.TEXT & ~filters.COMMAND, handle_phone)],
            ARRIVAL:    [MessageHandler(filters.TEXT & ~filters.COMMAND, handle_arrival)],
            CONFIRM:    [CallbackQueryHandler(handle_confirm,   pattern="^confirm_(agree|change|cancel)$")],
            EDIT_MENU:  [CallbackQueryHandler(handle_edit_menu, pattern="^edit_")],
            EDIT_FIELD: [MessageHandler(filters.TEXT & ~filters.COMMAND, handle_edit_field)],
        },
        fallbacks=[
            CommandHandler("cancel", cancel),
            CommandHandler("start",  cancel),
        ],
        allow_reentry=True,
    )
