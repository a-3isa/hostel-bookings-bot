"""User-facing strings (Arabic only — receptionist data-entry bot)."""

_AR = {
    # First-step router
    "choose_action":    "اختر العملية:",
    "btn_add_booking":  "➕ حجز",
    "btn_add_expense":  "💸 مصروف",
    # Expense flow
    "exp_ask_id":       "🔢 رقم المصروف (إن وجد) أو اضغط تخطي:",
    "exp_ask_item":     "📝 البند (وصف المصروف):",
    "exp_ask_amount":   "💰 المبلغ:",
    "exp_ask_apartment":"🏠 الشقة:",
    "btn_apt_none":     "بدون/عام",
    "exp_ask_payment":  "💳 طريقة الدفع:",
    "exp_ask_notes":    "🗒️ ملاحظات (اختياري) أو اضغط تخطي:",
    "exp_confirm_summary": (
        "📋 *مراجعة المصروف:*\n\n"
        "🔢 رقم المصروف: {exp_id}\n"
        "📝 البند: {item}\n"
        "💰 المبلغ: {amount}\n"
        "🏠 الشقة: {apartment}\n"
        "💳 الدفع: {payment}\n"
        "🗒️ ملاحظات: {notes}\n"
        "👤 المسئول: {responsible}\n"
        "🕐 التاريخ: {date}"
    ),
    "exp_group_msg": (
        "💸 *مصروف جديد*\n\n"
        "🔢 رقم المصروف: {exp_id}\n"
        "📝 البند: {item}\n"
        "💰 المبلغ: {amount}\n"
        "🏠 الشقة: {apartment}\n"
        "💳 الدفع: {payment}\n"
        "🗒️ ملاحظات: {notes}\n"
        "👤 المسئول: {responsible}\n"
        "🕐 التاريخ: {date}"
    ),
    "exp_saved":          "✅ تم حفظ المصروف وإرساله للجروب.\nأرسل /start من جديد.",
    "exp_saved_no_group": "✅ تم حفظ المصروف.\n⚠️ تعذّر الإرسال للجروب (تأكد من إضافة البوت).\nأرسل /start من جديد.",
    # Booking ID
    "ask_booking_id":   "🔖 أدخل رقم البوكينج (إن وجد) أو اضغط تخطي:",
    "btn_skip":         "تخطي",
    # Private ID
    "ask_private_id":   "🆔 أدخل الـ ID:",
    # Name
    "ask_name":         "👤 اسم المقيم:",
    "name_error":       "❌ أحرف ومسافات فقط، 3 أحرف على الأقل. حاول مجدداً:",
    # Booking type
    "ask_btype":        "📑 نوع الحجز:",
    # Phone
    "ask_phone":        "📞 رقم الهاتف:",
    "phone_error":      "❌ أرقام فقط (يمكن + في البداية)، 7 أرقام على الأقل. حاول مجدداً:",
    # Apartment / room (one combined keyboard)
    "ask_apt_room":     "🏠 اختر الشقة والغرفة:",
    # Nights
    "ask_nights":       "🌙 عدد الليالي:",
    "btn_infinity":     "∞ مفتوح",
    "num_error":        "❌ أدخل رقماً صحيحاً:",
    # Arrival date
    "ask_arrival":      "📅 اختر تاريخ البداية:",
    "cal_months":       ["", "يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو",
                         "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر"],
    "cal_days":         ["Sa", "Su", "Mo", "Tu", "We", "Th", "Fr"],
    # Money
    "ask_total":        "💰 اجمالي سعر الحجز:",
    "ask_payment":      "💳 طريقة الدفع:",
    "ask_paid":         "💵 اجمالي ما تم دفعه:",
    # Notes
    "ask_notes":        "📝 ملاحظات (اختياري) أو اضغط تخطي:",
    # Confirm  (نسبة البرنامج / صافي الدخل / تاريخ المغادرة تُحسب تلقائياً في الجدول)
    "confirm_summary": (
        "📋 *مراجعة الحجز:*\n\n"
        "🔖 بوكنج ID: {booking_id}\n"
        "🆔 ID: {private_id}\n"
        "👤 المقيم: {name}\n"
        "📑 نوع الحجز: {btype}\n"
        "📞 الهاتف: {phone}\n"
        "🏠 الشقة: {apartment}\n"
        "🚪 الغرفة: {room}\n"
        "🌙 عدد الليالي: {nights}\n"
        "📅 البداية: {arrival}\n"
        "📅 المغادرة: {departure}\n"
        "💰 الاجمالي: {total}\n"
        "💵 المدفوع: {paid}\n"
        "🧾 المتبقي: {remaining}\n"
        "💳 الدفع: {payment}\n"
        "📝 ملاحظات: {notes}"
    ),
    "group_msg": (
        "🆕 *حجز جديد*\n\n"
        "🔖 بوكنج ID: {booking_id}\n"
        "🆔 ID: {private_id}\n"
        "👤 المقيم: {name}\n"
        "📑 نوع الحجز: {btype}\n"
        "📞 الهاتف: {phone}\n"
        "🏠 الشقة: {apartment}\n"
        "🚪 الغرفة: {room}\n"
        "🌙 عدد الليالي: {nights}\n"
        "📅 البداية: {arrival}\n"
        "📅 المغادرة: {departure}\n"
        "💰 الاجمالي: {total}\n"
        "💵 المدفوع: {paid}\n"
        "🧾 المتبقي: {remaining}\n"
        "💳 الدفع: {payment}\n"
        "📝 ملاحظات: {notes}"
    ),
    "btn_confirm":      "✅ حفظ",
    "btn_cancel":       "❌ إلغاء",
    "saved":            "✅ تم حفظ الحجز وإرساله للجروب.\nأرسل /start لإدخال حجز جديد.",
    "saved_no_group":   "✅ تم حفظ الحجز.\n⚠️ تعذّر الإرسال للجروب (تأكد من إضافة البوت للجروب).\nأرسل /start لإدخال حجز جديد.",
    "cancelled":        "تم الإلغاء. أرسل /start للبدء من جديد.",
    "error":            "⚠️ حدث خطأ أثناء الحفظ. حاول مجدداً.",
    # Display helpers
    "infinity_label":   "∞ مفتوح",
    "empty":            "—",
}


def t(key: str, **kwargs) -> str:
    val = _AR.get(key, key)
    if isinstance(val, str) and kwargs:
        return val.format(**kwargs)
    return val
