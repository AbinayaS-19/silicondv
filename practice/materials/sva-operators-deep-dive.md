---
title: SVA Operators Deep Dive
track: sva
level: intermediate
---

# SVA Operators Deep Dive

Sequences are the building blocks of properties. A sequence describes a pattern
of signal values over time; a property says when that pattern must hold. Most
SVA debugging pain comes from sequence semantics rather than syntax, so this
note is about the operators: what they really mean, where they bite, and which
one to reach for.

## Sequences, attempts, and threads

When you write `req ##[1:4] ack`, the simulator starts a new evaluation
attempt every cycle on which the first element can begin. Attempts overlap,
and each one is an independent thread. If `req` holds on cycles 1, 2, and 3,
three attempts run at once, each watching for its own `ack`.

Two consequences I keep in mind:

1. A property can pass and fail on the same cycle for different attempts.
   Match the failure time against the waveform to find which attempt failed.
2. A sequence describes a finite behavior with a start and an end. Keep
   sequences short; a sequence sprawling across 20 cycles is hard to debug
   and even harder to prove.

## Basic sequence syntax

```systemverilog
sequence s_req_ack;
  req ##1 ack;
endsequence
property p_req_ack;
  @(posedge clk) disable iff (!rst_n)
    s_req_ack.matched |-> ##1 done;
endproperty
assert property (p_req_ack);
```

A named sequence keeps the property readable, and `.matched` lets you use the
sequence as an antecedent: it is true on the cycle the sequence completes.
There is also `.triggered`, which detects a completed match from a different
clocking context. Inside single-clock properties I stick with `.matched`.

## The cycle delay operator ##

`##1` means "one clock cycle later". `##0` means the same cycle. A range
`##[1:4]` means between 1 and 4 cycles later, and `##[*]` means any number of
cycles (unbounded, use with care).

```systemverilog
// ack arrives 1 to 4 cycles after req
sequence s_bounded_ack;
  req ##[1:4] ack;
endsequence
```

Delays count clock ticks of the sequence's clock, not absolute time. A range
like `##[1:8]` does not create one attempt; it creates up to eight ways for a
single attempt to match, which is why ranges pair with `first_match` (below).

## Repetition operators

Consecutive repetition `[*]`:

```systemverilog
// valid stays high for exactly 4 cycles, then ready
sequence s_burst;
  valid [*4] ##1 ready;
endsequence
```

Non-consecutive repetition `[=]` and go-to repetition `[->]`:

```systemverilog
// req high on exactly 3 cycles, gaps allowed, then ack
sequence s_nc;
  req [=3] ##1 ack;
endsequence
// req high on exactly 3 cycles, lined up on the last one, then ack
sequence s_goto;
  req [->3] ##1 ack;
endsequence
```

| Operator     | Name                 | Meaning                                                        |
| ------------ | -------------------- | -------------------------------------------------------------- |
| `sig [*4]`   | Consecutive          | sig high 4 cycles back to back                                 |
| `sig [*1:4]` | Consecutive range    | sig high 1 to 4 cycles back to back                            |
| `sig [=3]`   | Non-consecutive      | sig high on exactly 3 cycles, gaps allowed; match ends one cycle after the 3rd |
| `sig [->3]`  | Go-to                | sig high on exactly 3 cycles; match ends exactly on the 3rd     |

The difference between `[=]` and `[->]` is one cycle, and it is a classic
off-by-one source. Walk through this timing:

```
// cycle:  1 2 3 4 5 6 7
// req:    1 0 1 0 1 0 0
// ack:    0 0 0 0 0 1 1
```

The third `req` lands on cycle 5.

* `req [->3] ##1 ack`: the `[->3]` match ends on cycle 5, `##1` moves to
  cycle 6, so `ack` is checked on cycle 6. Matches.
* `req [=3] ##1 ack`: the `[=3]` match ends one cycle after the third `req`
  (cycle 6), then `##1` moves to cycle 7, so `ack` is checked on cycle 7.
  Matches.

In practice, I use `[->]` when I want the handshake to line up on the last
beat, and I draw the timing diagram before I use `[=]`. Repetition ranges
like `[*1:8]` multiply the number of matches per attempt; wrap them in
`first_match` when they feed an implication.

## throughout

`expr throughout seq` requires the expression to hold on every cycle while the
sequence matches, from the first cycle to the last, inclusive.

```systemverilog
// valid must stay high during the whole 4-beat burst
sequence s_burst_valid;
  valid throughout (req ##1 data[*4]);
endsequence
```

Typical uses: an enable held during a burst, or a mode signal that must not
change mid-transaction. For reset I prefer `disable iff` over `throughout`;
the reset gate is cheaper to read and applies to the whole property.

## Combining sequences: and, or

```systemverilog
// both the data burst and the sideband completion happen;
// the match ends when the longer side finishes
sequence s_both;
  (data_valid[*4]) and (flag ##[2:6] done);
endsequence
// a transaction ends with either a normal or an error completion
sequence s_end;
  ok or err;
endsequence
```

`and` starts both sides on the same cycle and ends when the later side
finishes. `or` matches when either side matches. I use `or` for alternate
endings and `and` when two parallel behaviors must both complete. (`not`
exists too; I avoid it because a negated sequence confuses everyone who reads
the code later.)

## intersect, within

`seq1 intersect seq2` matches only when both sequences match over the same
interval: same start, same end, both complete together. Use it when two
descriptions of a behavior must agree cycle for cycle.

`seq1 within seq2` matches when seq1 completes inside the interval over which
seq2 matches. Use it for "this event happened while that window was open".

```systemverilog
// the ack pulse happens while the transaction window is open
sequence s_windowed;
  s_ack_pulse within (start ##[1:10] stop);
endsequence
```

## until and s_until

```systemverilog
// req stays high until gnt arrives; weak: if gnt never comes,
// the sequence still completes at the end of the run
sequence s_weak;
  req until gnt;
endsequence
// strong: gnt MUST actually arrive, or the property fails
sequence s_strong;
  req s_until gnt;
endsequence
```

Plain `until` is weak: if the right side never happens before the run ends,
the sequence still completes successfully. `s_until` is strong: the
terminating event must actually occur. I almost always want the strong form,
and I usually bound it: `req s_until (gnt or timeout)` keeps a hung arbiter
from passing silently. (`until_with` and `s_until_with` are the variants
where the terminating condition must coincide with the last cycle the left
side holds.)

## first_match

When a sequence can match in several ways (for example with `[*]` ranges),
`first_match` keeps only the earliest match. This matters for properties,
because without it every possible match gets checked and long ranges create
many overlapping attempts.

```systemverilog
property p_first;
  @(posedge clk) disable iff (!rst_n)
    first_match(req ##[1:8] ack) |-> done;
endproperty
```

Concrete case: `req ##[1:8] ack` with `ack` held high for 3 cycles gives one
attempt three matches, and the consequent is checked three times. With
`first_match`, only the earliest match drives the consequent. It also matters
for local variables: sampling at the first match captures the earliest value,
which is usually the one the protocol means.

## Local variables: a worked example

Local variables let a sequence remember a value and compare it later. Here is
the classic write-then-read data integrity check on a simple bus.

```systemverilog
property p_data_integrity;
  logic [31:0] captured;
  @(posedge clk) disable iff (!rst_n)
    (wr_en, captured = wr_data) ##1 !wr_en [*1:$] ##1 rd_en
      |-> (rd_data == captured);
endproperty
assert property (p_data_integrity);
```

Walk through it:

1. On the cycle `wr_en` is high, `captured` stores `wr_data`. The comma is
   the assignment operator inside a sequence: the assignment happens when
   that element matches.
2. `##1 !wr_en [*1:$]` waits any number of cycles with `wr_en` low. This is the
   unbounded wait for the read, which is fine for simulation checkers.
3. When `rd_en` fires, the property requires `rd_data` to equal the captured
   value.

Local variables are scoped to one evaluation attempt, so overlapping
transactions do not clobber each other. That is the part people miss: each
attempt gets its own copy of `captured`.

Gotchas I have learned the hard way:

* Assign on every path that reaches the check. A local variable read before
  any assignment on that attempt reads x.
* Keep the type narrow and the lifetime short. Formal tools unroll this state,
  so a 128-bit variable carried for 50 cycles costs real proof effort.
* You can update a variable on every iteration of a repetition. This is the
  standard latency-measurement idiom:

```systemverilog
// measure the actual latency and check it against the bound
property p_latency;
  int unsigned count;
  @(posedge clk) disable iff (!rst_n)
    (req, count = 0) ##1 (!ack, count = count + 1)[*1:16] ##1 ack
      |-> (count <= 8);
endproperty
```

Each cycle that `!ack` matches, `count` increments for that attempt only.
When `ack` arrives, the consequent checks the measured latency. This one
property replaces a whole family of `##[1:N]` guesses.

## Clocking inside sequences

A sequence can carry its own clocking event (`@(posedge clk_b)`), which makes
that part of the sequence sample on another clock. It is legal and occasionally
necessary at clock-domain boundaries. My rule is one clock per property; if I
need two, the sequence is really describing a CDC boundary, and I write it as
two single-clock properties plus a synchronizer check instead.

## Putting it together

Most real properties are one of these shapes:

* `req ##[min:max] ack` for latency bounds
* `valid throughout (req ##1 data[*n])` for burst integrity
* `(op, v = expr) ##[...] check |-> (result == v)` for data path tracking
* `(req, c = 0) ##1 (!ack, c = c+1)[*1:N] ##1 ack |-> (c <= MAX)` for measured latency
* `first_match(range) |-> consequent` whenever a range feeds an implication

Start from the cheat sheet shapes, then reach for `first_match` and local
variables when a single cycle is not enough to express the rule.

## Rules of thumb I use

* I draw the timing diagram before I write any repetition operator. Every
  time I skip this, I get an off-by-one.
* `[->]` to line up on the last beat; `[=]` when gaps are legal, minding the
  extra cycle it adds.
* `first_match` around every range that feeds an implication.
* Local variables for anything the RTL does not remember for me, kept narrow
  and short-lived.
* One clock per property. Two clocks means I am describing a CDC boundary and
  should split the property.
* `s_until` over `until`, and bound the wait with a timeout branch.

## Interview angle

What interviewers actually probe on SVA operators, and the answer they want:

* **"`[=]` vs `[->]`?"** Non-consecutive ends one cycle after the last
  occurrence; go-to ends exactly on it. Draw the 7-cycle timing example from
  this note; they want to see you can count cycles, not recite definitions.
* **"When do you use `first_match`?"** When a range gives one attempt several
  matches (e.g. `ack` held 3 cycles under `##[1:8]`), and when sampling a
  local variable at the earliest match.
* **"How do you check data integrity across a write and a later read?"**
  The local variable capture pattern: `(wr_en, captured = wr_data)` then
  compare on `rd_en`. Mention that each attempt gets its own copy.
* **"What happens when the antecedent holds on back-to-back cycles?"**
  Overlapping attempts, one per cycle, each an independent thread.
* **"Why is `##[*]` dangerous?"** Unbounded: hides slow responses in
  simulation and can stall a formal proof. Always prefer a bound from the spec.
