import math

from gantrylab.gantry_safety import ARM_PHRASE, Command, HardwareStatus, SafeGantryLink, SafetySupervisor


def status(**kw):
    base = dict(connected=True, homed=True, limit_x0=False, limit_y0=False, estop_pressed=False, x=50.0, y=20.0)
    base.update(kw)
    return HardwareStatus(**base)


def armed(mode="live"):
    s = SafetySupervisor(mode=mode)
    s.heartbeat(status(), 0)
    assert s.arm(ARM_PHRASE, 10).ok
    return s


def move(x=10.0, y=10.0, speed=5.0, source="operator", approval=None):
    return Command(kind="MOVE", x=x, y=y, speed=speed, source=source, approval_id=approval)


def test_disarmed_refuses_and_arming_needs_phrase_and_link():
    s = SafetySupervisor(mode="live")
    assert not s.validate(move(), 0).ok
    assert not s.arm(ARM_PHRASE, 0).ok
    s.heartbeat(status(), 0)
    assert not s.arm("yes", 1).ok
    assert s.arm(ARM_PHRASE, 1).ok


def test_rejects_never_clamps():
    s = armed()
    for x, y, sp in [(150, 10, 5), (-1, 10, 5), (10, math.nan, 5), (10, 10, 50), (10, 10, 0)]:
        assert not s.validate(move(x, y, sp), 20).ok
    assert s.validate(move(), 20).ok


def test_home_first():
    s = SafetySupervisor(mode="live")
    s.heartbeat(status(homed=False), 0)
    s.arm(ARM_PHRASE, 0)
    assert not s.validate(move(), 1).ok
    assert s.validate(Command(kind="HOME"), 1).ok
    assert s.validate(Command(kind="STOP"), 1).ok


def test_ai_needs_approval_and_validation():
    s = armed()
    assert not s.validate(move(source="ai"), 20).ok
    assert s.validate(move(source="ai", approval="op-1"), 20).ok
    assert not s.validate(move(x=999, source="ai", approval="op-1"), 20).ok


def test_heartbeat_loss_faults_and_latches():
    s = armed()
    sent = []
    link = SafeGantryLink(s, sent.append, kind="dry-run")
    v, tx = link.submit(move(), 5000)
    assert not v.ok and not tx
    assert s.state == "FAULT" and sent[0].kind == "STOP"
    s.heartbeat(status(), 5001)
    assert not s.arm(ARM_PHRASE, 5002).ok
    assert s.reset_latch(5003).ok and s.state == "DISARMED"


def test_estop_and_limit_switches():
    s = armed()
    s.heartbeat(status(estop_pressed=True), 20)
    assert s.state == "ESTOP" and not s.reset_latch(21).ok
    s.heartbeat(status(), 22)
    assert s.reset_latch(23).ok
    s2 = SafetySupervisor(mode="live")
    s2.heartbeat(status(limit_x0=True, x=2.0), 0)
    s2.arm(ARM_PHRASE, 0)
    assert not s2.validate(move(x=1.0), 1).ok


def test_dry_run_never_transmits_to_serial():
    s = armed(mode="dry-run")
    sent = []
    v, tx = SafeGantryLink(s, sent.append, kind="serial").submit(move(), 20)
    assert v.ok and not tx and sent == []
