from calendar import Calendar
from datetime import date as dt_date, datetime, timedelta
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    ContextTypes,
    ConversationHandler,
    CallbackQueryHandler,
    MessageHandler,
    CommandHandler,
    filters,
)
import config
import sheets
from strings import t
from utils.validators import validate_name

(
    BOOKING_ID, PRIVATE_ID, NAME, BTYPE, PHONE,
    APT_ROOM, NIGHTS, ARRIVAL, TOTAL, PAYMENT, PAID, NOTES, CONFIRM,
    CHOICE, EXP_ID, EXP_ITEM, EXP_AMOUNT, EXP_APT, EXP_PAY, EXP_NOTES, EXP_CONFIRM,
) = range(21)

EXP_PAYMENTS = ["كاش", "انستاباي"]

# ─── Option lists ──────────────────────────────────────────────────────────────

BTYPE_OPTS = ["خارجي", "بوكينج"]

APARTMENTS = [
    "ذاكر حسين", "احمد فهيم", "انبي 3", "انبي 2", "ابو حديد 11", "عبدالله العربي",
]

ROOMS_PER_APARTMENT = 5

PAYMENTS = [
    "كاش", "انستاباي", "Airbnb", "فودافون كاش",
    "فودافون كاش علي رقم شاكر", "علي شاكر", "غير مدفوع", "وي باي", "يورو", "دولار",
]

# Calendar weeks start on Saturday (firstweekday=5).
_CAL = Calendar(firstweekday=5)


# ─── Helpers ───────────────────────────────────────────────────────────────────

def _grid(options: list[str], prefix: str, per_row: int = 2) -> InlineKeyboardMarkup:
    rows = []
    for i in range(0, len(options), per_row):
        rows.append([
            InlineKeyboardButton(opt, callback_data=f"{prefix}{idx}")
            for idx, opt in enumerate(options[i:i + per_row], start=i)
        ])
    return InlineKeyboardMarkup(rows)


def _skip_kb(prefix: str) -> InlineKeyboardMarkup:
    return InlineKeyboardMarkup([[InlineKeyboardButton(t("btn_skip"), callback_data=prefix)]])


def _num_keyboard(lo: int, hi: int, prefix: str, extra=None, per_row: int = 5) -> InlineKeyboardMarkup:
    nums = [InlineKeyboardButton(str(n), callback_data=f"{prefix}{n}") for n in range(lo, hi + 1)]
    rows = [nums[i:i + per_row] for i in range(0, len(nums), per_row)]
    if extra:
        rows.append(extra)
    return InlineKeyboardMarkup(rows)


def _parse_num(text: str):
    try:
        return float(text.strip().replace(",", ""))
    except ValueError:
        return None


def _num(v):
    """Drop trailing .0 for whole numbers so the sheet stays clean."""
    f = float(v)
    return int(f) if f.is_integer() else round(f, 2)


def _txt(v):
    """Force a value to be stored as text (preserve leading zeros in phones/IDs).

    A leading apostrophe is Sheets' text marker — hidden in display, kept on read.
    """
    return f"'{v}" if v else v


# ─── Calendar (single date, past allowed) ──────────────────────────────────────

_MIN_DATE = dt_date(2000, 1, 1)


def _cal_keyboard(year: int, month: int) -> InlineKeyboardMarkup:
    today  = dt_date.today()
    months = t("cal_months")
    days   = t("cal_days")
    rows = [
        [
            InlineKeyboardButton("◀️", callback_data=f"cal_prev_{year}_{month:02d}"),
            InlineKeyboardButton(f"{months[month]} {year}", callback_data="cal_ignore"),
            InlineKeyboardButton("▶️", callback_data=f"cal_next_{year}_{month:02d}"),
        ],
        [InlineKeyboardButton(d, callback_data="cal_ignore") for d in days],
    ]
    for week in _CAL.monthdayscalendar(year, month):
        row = []
        for day in week:
            if day == 0:
                row.append(InlineKeyboardButton(" ", callback_data="cal_ignore"))
            else:
                d = dt_date(year, month, day)
                label = f"[{day}]" if d == today else str(day)
                row.append(InlineKeyboardButton(label, callback_data=f"cal_day_{year}_{month:02d}_{day:02d}"))
        rows.append(row)
    return InlineKeyboardMarkup(rows)


# ─── Router: booking or expense ────────────────────────────────────────────────

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    context.user_data.clear()
    user = update.effective_user
    if user.id in config.BOOKING_USER_IDS:
        return await start_booking(update, context)
    uname = (user.username or "").lower()
    if uname in config.EXPENSE_USERNAMES:
        return await _start_expense(update, context)
    kb = InlineKeyboardMarkup([
        [InlineKeyboardButton(t("btn_add_booking"), callback_data="choice_booking")],
        [InlineKeyboardButton(t("btn_add_expense"), callback_data="choice_expense")],
    ])
    await update.effective_message.reply_text(t("choose_action"), reply_markup=kb)
    return CHOICE


async def handle_choice(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()
    if query.data == "choice_expense":
        return await _start_expense(update, context)
    await query.message.reply_text(t("ask_booking_id"), reply_markup=_skip_kb("bid_skip"))
    return BOOKING_ID


# ─── Step 1: Booking ID ────────────────────────────────────────────────────────

async def start_booking(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    context.user_data.clear()
    await update.effective_message.reply_text(
        t("ask_booking_id"), reply_markup=_skip_kb("bid_skip")
    )
    return BOOKING_ID


async def handle_booking_id(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    if update.callback_query:
        await update.callback_query.answer()
        context.user_data["booking_id"] = ""
    else:
        context.user_data["booking_id"] = update.message.text.strip()
    await update.effective_message.reply_text(t("ask_private_id"))
    return PRIVATE_ID


# ─── Step 2: Private ID ────────────────────────────────────────────────────────

async def handle_private_id(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    context.user_data["private_id"] = update.message.text.strip()
    await update.message.reply_text(t("ask_name"))
    return NAME


# ─── Step 3: Name ──────────────────────────────────────────────────────────────

async def handle_name(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    result = validate_name(update.message.text)
    if result is None:
        await update.message.reply_text(t("name_error"))
        return NAME
    context.user_data["name"] = result
    # Step 4: booking type — auto بوكينج when Booking ID present.
    if context.user_data.get("booking_id"):
        context.user_data["btype"] = "بوكينج"
        return await _ask_phone(update, context)
    await update.message.reply_text(t("ask_btype"), reply_markup=_grid(BTYPE_OPTS, "bt_"))
    return BTYPE


# ─── Step 4: Booking type ──────────────────────────────────────────────────────

async def handle_btype(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()
    context.user_data["btype"] = BTYPE_OPTS[int(query.data[3:])]
    return await _ask_phone(update, context)


# ─── Step 5: Phone ─────────────────────────────────────────────────────────────

async def _ask_phone(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    await update.effective_message.reply_text(t("ask_phone"))
    return PHONE


async def handle_phone(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    context.user_data["phone"] = update.message.text.strip()
    await update.message.reply_text(t("ask_apt_room"), reply_markup=_apt_room_kb())
    return APT_ROOM


# ─── Step 6: Apartment + room (one combined keyboard) ─────────────────────────

def _apt_room_kb() -> InlineKeyboardMarkup:
    rows = []
    for i, apt in enumerate(APARTMENTS):
        rows.append([InlineKeyboardButton(f"🏠 {apt}", callback_data="ar_hdr")])
        rows.append([
            InlineKeyboardButton(str(n), callback_data=f"ar_{i}_{n}")
            for n in range(1, ROOMS_PER_APARTMENT + 1)
        ])
    return InlineKeyboardMarkup(rows)


async def handle_apt_room_hdr(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    await update.callback_query.answer()
    return APT_ROOM


async def handle_apt_room(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()
    apt_idx, room = query.data[len("ar_"):].split("_")
    context.user_data["apartment"] = APARTMENTS[int(apt_idx)]
    context.user_data["room"] = room
    nights_extra = [InlineKeyboardButton(t("btn_infinity"), callback_data="nights_inf")]
    await query.message.reply_text(
        t("ask_nights"), reply_markup=_num_keyboard(1, 30, "nights_", extra=nights_extra, per_row=5)
    )
    return NIGHTS


# ─── Step 9: Nights (buttons 1–9 + ∞, manual entry for >9) ──────────────────────

async def handle_nights(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    if update.callback_query:
        await update.callback_query.answer()
        suffix = update.callback_query.data[len("nights_"):]
        if suffix == "inf":
            context.user_data["infinity"] = True
            context.user_data["nights"] = None
        else:
            context.user_data["infinity"] = False
            context.user_data["nights"] = int(suffix)
        return await _ask_arrival(update, context)
    val = _parse_num(update.message.text)
    if val is None or val <= 0:
        await update.message.reply_text(t("num_error"))
        return NIGHTS
    context.user_data["infinity"] = False
    context.user_data["nights"] = int(val)
    return await _ask_arrival(update, context)


# ─── Step 10: Arrival date ─────────────────────────────────────────────────────

async def _ask_arrival(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    today = dt_date.today()
    context.user_data["cal_year"]  = today.year
    context.user_data["cal_month"] = today.month
    await update.effective_message.reply_text(
        t("ask_arrival"), reply_markup=_cal_keyboard(today.year, today.month)
    )
    return ARRIVAL


async def handle_cal_nav(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()
    parts = query.data.split("_")
    direction, year, month = parts[1], int(parts[2]), int(parts[3])
    if direction == "prev":
        new = dt_date(year, month, 1) - timedelta(days=1)
    else:
        new = (dt_date(year, month, 28) + timedelta(days=4)).replace(day=1)
    if new < _MIN_DATE:
        return ARRIVAL
    context.user_data["cal_year"]  = new.year
    context.user_data["cal_month"] = new.month
    await query.message.reply_text(t("ask_arrival"), reply_markup=_cal_keyboard(new.year, new.month))
    return ARRIVAL


async def handle_cal_day(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()
    _, _, yr, mo, dy = query.data.split("_")
    context.user_data["arrival_date"] = dt_date(int(yr), int(mo), int(dy))
    await query.message.reply_text(t("ask_total"))
    return TOTAL


async def handle_cal_ignore(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    await update.callback_query.answer()
    return ARRIVAL


# ─── Step 11: Total ────────────────────────────────────────────────────────────

async def handle_total(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    val = _parse_num(update.message.text)
    if val is None or val < 0:
        await update.message.reply_text(t("num_error"))
        return TOTAL
    context.user_data["total"] = val
    await update.message.reply_text(t("ask_payment"), reply_markup=_grid(PAYMENTS, "pay_"))
    return PAYMENT


# ─── Step 12: Payment ──────────────────────────────────────────────────────────

async def handle_payment(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()
    context.user_data["payment"] = PAYMENTS[int(query.data[4:])]
    # غير مدفوع → nothing paid; skip the paid step.
    if context.user_data["payment"] == "غير مدفوع":
        context.user_data["paid"] = 0.0
        await query.message.reply_text(t("ask_notes"), reply_markup=_skip_kb("notes_skip"))
        return NOTES
    await query.message.reply_text(t("ask_paid"))
    return PAID


# ─── Step 13: Paid ─────────────────────────────────────────────────────────────

async def handle_paid(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    val = _parse_num(update.message.text)
    if val is None or val < 0:
        await update.message.reply_text(t("num_error"))
        return PAID
    context.user_data["paid"] = val
    await update.message.reply_text(t("ask_notes"), reply_markup=_skip_kb("notes_skip"))
    return NOTES


# ─── Step 14: Notes ────────────────────────────────────────────────────────────

async def handle_notes(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    if update.callback_query:
        await update.callback_query.answer()
        context.user_data["notes"] = ""
    else:
        context.user_data["notes"] = update.message.text.strip()
    return await _show_confirm(update, context)


# ─── Confirm ───────────────────────────────────────────────────────────────────

def _derived(d: dict) -> dict:
    """Display-only fields. نسبة / صافي / تاريخ المغادرة are computed by the sheet."""
    remaining = d["total"] - d["paid"]
    if d["infinity"]:
        nights_disp = t("infinity_label")
        departure   = t("infinity_label")
    else:
        nights_disp = str(d["nights"])
        departure   = (d["arrival_date"] + timedelta(days=d["nights"])).isoformat()
    return {"remaining": _num(remaining), "nights_disp": nights_disp, "departure": departure}


def _summary_kwargs(d: dict, dv: dict) -> dict:
    return dict(
        booking_id=d["booking_id"] or t("empty"),
        private_id=d["private_id"], name=d["name"], btype=d["btype"],
        phone=d["phone"], apartment=d["apartment"],
        room=d["room"], nights=dv["nights_disp"], arrival=d["arrival_date"].isoformat(),
        departure=dv["departure"], total=_num(d["total"]), paid=_num(d["paid"]),
        remaining=dv["remaining"], payment=d["payment"], notes=d["notes"] or t("empty"),
    )


async def _show_confirm(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    d  = context.user_data
    dv = _derived(d)
    keyboard = InlineKeyboardMarkup([
        [InlineKeyboardButton(t("btn_confirm"), callback_data="save")],
        [InlineKeyboardButton(t("btn_cancel"),  callback_data="cancel")],
    ])
    await update.effective_message.reply_text(
        t("confirm_summary", **_summary_kwargs(d, dv)),
        parse_mode="Markdown",
        reply_markup=keyboard,
    )
    return CONFIRM


async def handle_confirm(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()
    if query.data == "cancel":
        await query.message.reply_text(t("cancelled"))
        return ConversationHandler.END

    d  = context.user_data
    dv = _derived(d)

    # Column I (عدد الليالي): open-ended → live formula; else the integer.
    # Column J = تاريخ البداية; the sheet derives K (مغادرة) = J + I automatically.
    nights_cell = "=TODAY()-J{row}" if d["infinity"] else d["nights"]

    # Input columns only. The sheet owns B? No — per request we overwrite B (ID).
    # Formula columns K, N, P, R, S are left untouched so the sheet recomputes them
    # (P = المتبقي is calculated in the sheet, so the bot never writes it).
    a_to_j = [
        _txt(d["booking_id"]), _txt(d["private_id"]), d["name"], d["btype"],
        "", _txt(d["phone"]), d["apartment"], int(d["room"]),  # E (الجنسية) retired, kept blank for column alignment
        nights_cell, d["arrival_date"].isoformat(),
    ]
    l_m = [_num(d["total"]), _num(d["paid"])]
    o_and_q = [d["payment"], d["notes"]]

    try:
        sheets.append_booking_input(a_to_j, l_m, o_and_q)
    except Exception:
        await query.message.reply_text(t("error"))
        return CONFIRM

    # Post to the Telegram group (best-effort; booking is already saved).
    try:
        await context.bot.send_message(
            chat_id=int(config.GROUP_CHAT_ID),
            text=t("group_msg", **_summary_kwargs(d, dv)),
            parse_mode="Markdown",
        )
        await query.message.reply_text(t("saved"))
    except Exception:
        await query.message.reply_text(t("saved_no_group"))
    return ConversationHandler.END


# ─── Expense flow ──────────────────────────────────────────────────────────────

def _responsible(update: Update) -> str:
    u = update.effective_user
    return u.full_name or (f"@{u.username}" if u.username else str(u.id))


async def _start_expense(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    await update.effective_message.reply_text(t("exp_ask_id"), reply_markup=_skip_kb("eid_skip"))
    return EXP_ID


async def handle_exp_id(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    if update.callback_query:
        await update.callback_query.answer()
        context.user_data["exp_id"] = ""
    else:
        context.user_data["exp_id"] = update.message.text.strip()
    await update.effective_message.reply_text(t("exp_ask_item"))
    return EXP_ITEM


async def handle_exp_item(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    context.user_data["exp_item"] = update.message.text.strip()
    await update.message.reply_text(t("exp_ask_amount"))
    return EXP_AMOUNT


async def handle_exp_amount(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    val = _parse_num(update.message.text)
    if val is None or val < 0:
        await update.message.reply_text(t("num_error"))
        return EXP_AMOUNT
    context.user_data["exp_amount"] = val
    rows = list(_grid(APARTMENTS, "eapt_").inline_keyboard)
    rows.append([InlineKeyboardButton(t("btn_apt_none"), callback_data="eapt_none")])
    await update.message.reply_text(t("exp_ask_apartment"), reply_markup=InlineKeyboardMarkup(rows))
    return EXP_APT


async def handle_exp_apt(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()
    suffix = query.data[len("eapt_"):]
    context.user_data["exp_apartment"] = "" if suffix == "none" else APARTMENTS[int(suffix)]
    await query.message.reply_text(t("exp_ask_payment"), reply_markup=_grid(EXP_PAYMENTS, "epay_"))
    return EXP_PAY


async def handle_exp_pay(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()
    context.user_data["exp_payment"] = EXP_PAYMENTS[int(query.data[len("epay_"):])]
    await query.message.reply_text(t("exp_ask_notes"), reply_markup=_skip_kb("enotes_skip"))
    return EXP_NOTES


async def handle_exp_notes(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    if update.callback_query:
        await update.callback_query.answer()
        context.user_data["exp_notes"] = ""
    else:
        context.user_data["exp_notes"] = update.message.text.strip()
    return await _show_exp_confirm(update, context)


def _exp_kwargs(update: Update, context: ContextTypes.DEFAULT_TYPE) -> dict:
    d = context.user_data
    return dict(
        exp_id=d.get("exp_id") or t("empty"),
        item=d["exp_item"], amount=_num(d["exp_amount"]),
        apartment=d["exp_apartment"] or t("empty"), payment=d["exp_payment"],
        notes=d["exp_notes"] or t("empty"), responsible=_responsible(update),
        date=datetime.now().strftime("%Y-%m-%d %H:%M"),
    )


async def _show_exp_confirm(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    keyboard = InlineKeyboardMarkup([
        [InlineKeyboardButton(t("btn_confirm"), callback_data="esave")],
        [InlineKeyboardButton(t("btn_cancel"),  callback_data="ecancel")],
    ])
    await update.effective_message.reply_text(
        t("exp_confirm_summary", **_exp_kwargs(update, context)),
        parse_mode="Markdown",
        reply_markup=keyboard,
    )
    return EXP_CONFIRM


async def handle_exp_confirm(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    query = update.callback_query
    await query.answer()
    if query.data == "ecancel":
        await query.message.reply_text(t("cancelled"))
        return ConversationHandler.END

    d = context.user_data
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    row = [
        now,                       # A تاريخ
        d["exp_item"],             # B البند
        _num(d["exp_amount"]),     # C المبلغ
        d["exp_apartment"],        # D الشقة
        d["exp_notes"],            # E ملاحظات
        d["exp_payment"],          # F طريقة الدفع
        _responsible(update),      # G اسم المسئول
        _txt(d.get("exp_id", "")), # H الرقم
    ]
    try:
        sheets.append_expense_row(row)
    except Exception:
        await query.message.reply_text(t("error"))
        return EXP_CONFIRM

    try:
        await context.bot.send_message(
            chat_id=int(config.EXPENSE_GROUP_CHAT_ID),
            text=t("exp_group_msg", **_exp_kwargs(update, context)),
            parse_mode="Markdown",
        )
        await query.message.reply_text(t("exp_saved"))
    except Exception:
        await query.message.reply_text(t("exp_saved_no_group"))
    return ConversationHandler.END


# ─── Cancel ────────────────────────────────────────────────────────────────────

async def cancel(update: Update, context: ContextTypes.DEFAULT_TYPE) -> int:
    await update.effective_message.reply_text(t("cancelled"))
    return ConversationHandler.END


# ─── Build handler ─────────────────────────────────────────────────────────────

def build_booking_handler() -> ConversationHandler:
    return ConversationHandler(
        entry_points=[CommandHandler("start", start)],
        states={
            CHOICE: [
                CallbackQueryHandler(handle_choice, pattern=r"^choice_(booking|expense)$"),
            ],
            EXP_ID: [
                CallbackQueryHandler(handle_exp_id, pattern="^eid_skip$"),
                MessageHandler(filters.TEXT & ~filters.COMMAND, handle_exp_id),
            ],
            EXP_ITEM:   [MessageHandler(filters.TEXT & ~filters.COMMAND, handle_exp_item)],
            EXP_AMOUNT: [MessageHandler(filters.TEXT & ~filters.COMMAND, handle_exp_amount)],
            EXP_APT:    [CallbackQueryHandler(handle_exp_apt, pattern=r"^eapt_(\d+|none)$")],
            EXP_PAY:    [CallbackQueryHandler(handle_exp_pay, pattern=r"^epay_\d+$")],
            EXP_NOTES: [
                CallbackQueryHandler(handle_exp_notes, pattern="^enotes_skip$"),
                MessageHandler(filters.TEXT & ~filters.COMMAND, handle_exp_notes),
            ],
            EXP_CONFIRM: [CallbackQueryHandler(handle_exp_confirm, pattern=r"^(esave|ecancel)$")],
            BOOKING_ID: [
                CallbackQueryHandler(handle_booking_id, pattern="^bid_skip$"),
                MessageHandler(filters.TEXT & ~filters.COMMAND, handle_booking_id),
            ],
            PRIVATE_ID:  [MessageHandler(filters.TEXT & ~filters.COMMAND, handle_private_id)],
            NAME:        [MessageHandler(filters.TEXT & ~filters.COMMAND, handle_name)],
            BTYPE:       [CallbackQueryHandler(handle_btype, pattern=r"^bt_\d+$")],
            PHONE:       [MessageHandler(filters.TEXT & ~filters.COMMAND, handle_phone)],
            APT_ROOM: [
                CallbackQueryHandler(handle_apt_room,     pattern=r"^ar_\d+_\d+$"),
                CallbackQueryHandler(handle_apt_room_hdr, pattern=r"^ar_hdr$"),
            ],
            NIGHTS: [
                CallbackQueryHandler(handle_nights, pattern=r"^nights_(inf|\d+)$"),
                MessageHandler(filters.TEXT & ~filters.COMMAND, handle_nights),
            ],
            ARRIVAL: [
                CallbackQueryHandler(handle_cal_day,    pattern=r"^cal_day_"),
                CallbackQueryHandler(handle_cal_nav,    pattern=r"^cal_(prev|next)_"),
                CallbackQueryHandler(handle_cal_ignore, pattern=r"^cal_ignore$"),
            ],
            TOTAL:   [MessageHandler(filters.TEXT & ~filters.COMMAND, handle_total)],
            PAYMENT: [CallbackQueryHandler(handle_payment, pattern=r"^pay_\d+$")],
            PAID:    [MessageHandler(filters.TEXT & ~filters.COMMAND, handle_paid)],
            NOTES: [
                CallbackQueryHandler(handle_notes, pattern="^notes_skip$"),
                MessageHandler(filters.TEXT & ~filters.COMMAND, handle_notes),
            ],
            CONFIRM: [CallbackQueryHandler(handle_confirm, pattern=r"^(save|cancel)$")],
        },
        fallbacks=[CommandHandler("cancel", cancel)],
        allow_reentry=True,
    )
