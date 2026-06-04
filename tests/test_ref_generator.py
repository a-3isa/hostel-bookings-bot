from utils.ref_generator import format_ref


def test_format_ref_pads_to_six_digits():
    assert format_ref(1) == "BK-000001"


def test_format_ref_preserves_large_number():
    assert format_ref(42) == "BK-000042"


def test_format_ref_max():
    assert format_ref(999999) == "BK-999999"


def test_format_ref_counter_1000():
    assert format_ref(1000) == "BK-001000"
