from functools import wraps
from telegram import Update
from telegram.ext import ContextTypes
import config
import sheets


def admin_only(func):
    @wraps(func)
    async def wrapper(update: Update, context: ContextTypes.DEFAULT_TYPE):
        if update.effective_user.id not in config.ADMIN_IDS:
            return
        return await func(update, context)
    return wrapper


@admin_only
async def set_available(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not context.args:
        await update.message.reply_text("Usage: /set_available <room_id>")
        return
    room_id = context.args[0].upper()
    try:
        sheets.set_room_availability(room_id, True)
        await update.message.reply_text(f"✅ {room_id} is now available.")
    except ValueError as e:
        await update.message.reply_text(f"❌ {e}")


@admin_only
async def set_unavailable(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not context.args:
        await update.message.reply_text("Usage: /set_unavailable <room_id>")
        return
    room_id = context.args[0].upper()
    try:
        sheets.set_room_availability(room_id, False)
        await update.message.reply_text(f"✅ {room_id} is now unavailable.")
    except ValueError as e:
        await update.message.reply_text(f"❌ {e}")


@admin_only
async def add_room(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if len(context.args) < 2:
        await update.message.reply_text("Usage: /add_room <location_id> <room_number>")
        return
    location_id, room_number = context.args[0].upper(), context.args[1]
    room_id = sheets.add_room(location_id, room_number)
    await update.message.reply_text(
        f"✅ Room {room_number} added as `{room_id}` at {location_id}.",
        parse_mode="Markdown",
    )


@admin_only
async def remove_room(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not context.args:
        await update.message.reply_text("Usage: /remove_room <room_id>")
        return
    room_id = context.args[0].upper()
    try:
        sheets.remove_room(room_id)
        await update.message.reply_text(f"✅ Room {room_id} removed.")
    except ValueError as e:
        await update.message.reply_text(f"❌ {e}")


@admin_only
async def list_rooms(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not context.args:
        await update.message.reply_text("Usage: /list_rooms <location_id>")
        return
    location_id = context.args[0].upper()
    rooms = sheets.get_rooms_by_location(location_id)
    if not rooms:
        await update.message.reply_text(f"No rooms found for {location_id}.")
        return
    lines = [
        f"🚪 Room {r['room_number']} (`{r['room_id']}`) — "
        f"{'✅ Available' if str(r['is_available']).upper() == 'TRUE' else '❌ Unavailable'}"
        for r in rooms
    ]
    await update.message.reply_text(
        f"Rooms at {location_id}:\n" + "\n".join(lines), parse_mode="Markdown"
    )


@admin_only
async def upload_photo(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    replied = update.message.reply_to_message
    if not replied or not replied.photo:
        await update.message.reply_text(
            "Reply to a photo message with /upload_photo to get its file ID."
        )
        return
    file_id = replied.photo[-1].file_id
    await update.message.reply_text(
        f"📋 File ID (paste into the Rooms sheet):\n`{file_id}`",
        parse_mode="Markdown",
    )
