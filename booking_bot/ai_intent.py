"""The model's side of the AI booking edit: what it is told and what it may answer.

One module, so the n8n node (`build_workflow.py`, `deploy_graph.py`) and the live
check (`eval_ai_intents.py`) can never disagree about the schema or the prompt.

The model only READS a staff message and fills in a small JSON request. It has no
tools and writes nothing; `brain.js` re-validates every field and does all the
looking up and arithmetic. See docs/superpowers/specs/2026-10-12-ai-booking-edit-design.md.
"""

MODEL = "claude-haiku-5-5"

# The keys brain.js PAYMENTS accepts for money arriving: all of them but 'unpaid',
# which is the absence of a payment. test_ai_intent.py keeps the two lists equal.
METHODS = ["cash", "instapay", "airbnb", "vcash", "eur", "usd"]

# Every part is optional and none is ever null: a part the message does not ask
# for is simply left out.
SCHEMA = {
    "type": "object",
    "properties": {
        "booking_id": {
            "type": "string",
            "description": "The booking's ID exactly as the staff member wrote it, "
                           "digits only. Never invent one.",
        },
        "guest_name": {
            "type": "string",
            "description": "The guest's name exactly as written, only when the message names the "
                           "guest and gives no booking ID. Just the name: no 'booking', amounts "
                           "or payment words.",
        },
        "payment": {
            "type": "object",
            "description": "Money the guest paid (positive) or was given back (negative).",
            "properties": {
                "amount": {"type": "number"},
                "method": {"type": "string", "enum": METHODS},
            },
            "required": ["amount", "method"],
        },
        "room": {
            "type": "object",
            "description": "Move the booking to this apartment and room.",
            "properties": {
                "apartment": {"type": "string"},
                "room": {"type": "string", "description": "The room number, digits only."},
            },
            "required": ["apartment", "room"],
        },
        "stay": {
            "type": "object",
            "description": "Change how long the guest stays.",
            "properties": {
                "kind": {"type": "string", "enum": ["extend", "until", "leave"]},
                "nights": {"type": "integer", "description": "For kind=extend: how many nights to add."},
                "date": {"type": "string", "description": "yyyy-mm-dd. For kind=until: the last day. "
                                                          "For kind=leave: the day the guest left; "
                                                          "leave it out for today."},
            },
            "required": ["kind"],
        },
        "unclear": {
            "type": "string",
            "description": "Only when the request cannot be understood: a short reason, "
                           "in the staff member's language.",
        },
    },
}

PROMPT = """You read one message from a hostel receptionist about an EXISTING booking and fill in a JSON edit request. You never decide anything else: the system looks the booking up and checks everything you write.

Messages are in Arabic or English; digits may be Arabic-Indic (٠١٢٣٤٥٦٧٨٩). Today is <<TODAY>> (Africa/Cairo).

Fill in only what the message asks for:

- booking_id: the booking's ID as written ("booking 3", "حجز 3", "ID 3"). Digits only. Never guess one.
- guest_name: use this INSTEAD of booking_id when the message names the guest and gives no ID ("حجز عبدالنبي دفع 400 كاش", "booking Hana Ali extend 2 nights"). Only the name, as written: no "حجز"/"booking", no amounts, no payment words. If an ID is given, leave guest_name out.
- If the message gives neither a booking ID nor a guest name, do not guess: set unclear.
- payment: money the guest paid (a positive amount) or was given back ("refund", "استرداد": a negative amount).
  method says how it was paid: cash / كاش / نقدي -> "cash"; instapay / انستاباي -> "instapay"; Vodafone Cash / فودافون كاش -> "vcash"; Airbnb -> "airbnb".
  For foreign money the CURRENCY decides the method, however it was handed over: dollars / USD / دولار -> "usd"; euros / EUR / يورو -> "eur". Egyptian pounds (EGP / جنيه) are the default currency.
  An amount with no way of paying: set unclear.
- room: the apartment and room number to MOVE the booking to. The apartment must be one of: <<APARTMENTS>>. Copy its spelling exactly from that list.
- stay: how long the guest stays.
  "extend" adds nights (nights = how many): "extend 2 nights", "زود ليلتين".
  "until" says the last day (date): "stays until the 20th".
  "leave" means the guest left or leaves (date = that day; leave date out for today): "left today", "غادر امبارح".
  Write dates as yyyy-mm-dd. Resolve "today", "tomorrow", "yesterday" and "the 20th" from today's date above.

One message can ask for several of these; include each one that was asked for and nothing else.
If you cannot tell what is being asked, or the message is not an edit request at all, set unclear to a short reason in the staff member's language and fill in nothing else."""


def n8n_prompt():
    """PROMPT as an n8n expression: today's date and the apartment names are live."""
    today = "{{ $now.setZone('Africa/Cairo').toFormat('yyyy-MM-dd') }}"
    # Best-effort (spec 5.2): referencing a node that did not run THROWS, which made
    # the whole extraction fail on the first live message. Brain matches the
    # apartment strictly against the registry anyway.
    apartments = ("{{ $('Read Locations').isExecuted ? [...new Set($('Read Locations').all()"
                  ".map(i => i.json['الشقة']).filter(Boolean))].join('، ') : '' }}")
    return "=" + PROMPT.replace("<<TODAY>>", today).replace("<<APARTMENTS>>", apartments)


def render_prompt(today, apartments):
    """PROMPT with real values, for checking the model outside n8n."""
    return PROMPT.replace("<<TODAY>>", today).replace("<<APARTMENTS>>", "، ".join(apartments))
