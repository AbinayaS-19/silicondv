---
title: SVA Cheat Sheet
track: sva
level: beginner
---

# SVA Cheat Sheet

A quick reference for SystemVerilog Assertions. Keep this open next to your editor
until the syntax becomes muscle memory.

## What SVA is for

SVA has three jobs, and each one uses a different keyword:

| Keyword  | Job                                     | Where it lives              |
| -------- | --------------------------------------- | --------------------------- |
| `assert` | Check that the design obeys a rule      | Testbench, bound to the DUT |
| `assume` | Constrain the stimulus or environment   | Formal testbench, on inputs |
| `cover`  | Record that an interesting scenario hit | Coverage collection         |

In simulation you will mostly write `assert` and `cover`. `assume` becomes
important once you touch formal verification (see the Formal-Ready Assertions
note). All three share the same property syntax, so everything in this sheet
applies to all of them.

## Anatomy of a concurrent assertion

Every concurrent assertion has the same four parts:

```systemverilog
assert property (
  @(posedge clk)          // 1. clocking event: when to sample
  disable iff (!rst_n)    // 2. reset gate: when to stay quiet
  req |-> ##[1:4] ack     // 3. the property expression
) else $error("ack too slow");  // 4. action block: what to do on failure
```

Read it as: on every rising clock edge, unless we are in reset, if `req` is
high then `ack` must arrive within 1 to 4 cycles; if not, print an error.
Miss any of the four parts and you get either a compile complaint or a false
failure at 3 AM. When I review someone else's assertion, I check these four
parts in this order.

## Immediate vs concurrent assertions

An immediate assertion evaluates in the active region, like a check in
procedural code. Use it for protocol checks inside always blocks.

```systemverilog
always_ff @(posedge clk) begin
  if (valid && !ready)
    assert (data != 'x) else $error("data went X while valid was high");
end
```

A concurrent assertion samples signals in the preponed region and evaluates over
clock ticks. Use it for anything that spans time.

```systemverilog
property p_valid_stable;
  @(posedge clk) valid && !ready |=> $stable(data);
endproperty
assert property (p_valid_stable);
```

|                         | Immediate `assert (...)`              | Concurrent `assert property (...)` |
| ----------------------- | ------------------------------------- | ---------------------------------- |
| When it evaluates       | Right there, in procedural code       | On clock edges, over time          |
| Sampling                | Current values (active region)        | Preponed region (start of the tick)|
| Time span               | A single moment                       | Can span many cycles               |
| Typical use             | Sanity checks inside always blocks    | Protocol rules, handshakes, latency|

Quick way to choose: if the rule needs the words "until", "within N cycles",
or "stays", it is concurrent. If it is a one-line sanity check on current
values, immediate is fine.

## Implication operators

`|->` is overlapping implication: the consequent starts on the same cycle the
antecedent matches. `|=>` is non-overlapping implication: the consequent starts
on the next cycle.

```systemverilog
// req on cycle N implies ack on cycle N (overlapping)
req |-> ack
// req on cycle N implies ack on cycle N+1 (non-overlapping)
req |=> ack
```

Rule of thumb: use `|->` when the response happens in the same cycle, `|=>`
when it is allowed one cycle of latency.

|                        | `\|->` (overlapping)              | `\|=>` (non-overlapping)          |
| ---------------------- | --------------------------------- | --------------------------------- |
| Consequent starts      | Same cycle as the antecedent      | Next cycle after the antecedent   |
| Equivalent form        |                                   | `a \|-> ##1 b` (exactly the same) |
| Use when               | Combinational response, same-cycle ack | Registered response, one cycle of latency |

`a |=> b` is literally `a |-> ##1 b`; they are the same thing written two
ways. When I mix them up, I rewrite the `|=>` as `|-> ##1` and check the
timing by hand against the waveform.

### The vacuous pass (read this twice)

An implication passes when its antecedent is false. `req |-> ack` with `req`
never asserted passes every cycle and tells you nothing. This is called a
vacuous pass, and it is the number one reason a green regression lies to you.

The fix is a cover property on the antecedent (see the Cover section below):
if the cover never hits, your assert proved nothing.

## Clocking

Always bind a concurrent assertion to a clock. Without one the assertion has no
sampling edge.

```systemverilog
assert property (@(posedge clk) a |-> b);
// with an async reset gate
assert property (@(posedge clk) disable iff (!rst_n) a |-> b);
```

`disable iff (!rst_n)` turns the assertion off during reset. Put it on every
property in a design with an async reset, or you will debug false failures.

For a synchronous active-high reset the gate follows the real reset:
`disable iff (rst)`. The point is that the gate must match the actual reset
in the design, not a guess. If you are unsure which reset a block uses, check
the always_ff sensitivity list in the RTL before writing the property.

## Sampled value functions

These work on the preponed (sampled) value of a signal:

| Function              | Meaning                                        |
| --------------------- | ---------------------------------------------- |
| `$rose(sig)`          | sig transitioned 0 to 1 (or 0/x/z to 1)        |
| `$fell(sig)`          | sig transitioned 1 to 0                        |
| `$stable(sig)`        | sig did not change since the last cycle        |
| `$past(sig)`          | value of sig one cycle ago                     |
| `$past(sig, 2)`       | value of sig two cycles ago                    |
| `$onehot(sig)`        | exactly one bit of sig is 1                    |
| `$onehot0(sig)`       | at most one bit of sig is 1                    |
| `$isunknown(sig)`     | sig contains x or z                            |
| `$countones(sig)`     | number of bits of sig that are 1               |

```systemverilog
// a valid transaction must never carry X
assert property (@(posedge clk) valid |-> !$isunknown(data));
// one-hot request lines
assert property (@(posedge clk) $onehot0(req_vec));
// data holds its value two cycles after load
assert property (@(posedge clk) load |=> ##2 (data_out == $past(data_in, 2)));
```

Two things about `$past` that bite beginners:

1. On the first sampled cycle after reset, `$past` returns x. If your property
   compares against it, that comparison fails on x. The four-argument form
   takes a gating expression, commonly the reset: `$past(sig, 1, rst_n)`
   returns x while reset is asserted instead of stale data.
2. `$past` counts clock ticks of the property's clock, not picoseconds. In a
   multi-clock property this gets confusing fast, so I keep one clock per
   property until I have a reason not to.

## Delays: the `##` operator

`##1` means one cycle later, `##0` the same cycle, and `##[1:4]` anywhere from
1 to 4 cycles later.

```systemverilog
// ack arrives 1 to 4 cycles after req
assert property (@(posedge clk) req |-> ##[1:4] ack);
// grant and data valid on the same cycle as the request
assert property (@(posedge clk) req |-> ##0 (gnt && data_valid));
```

`##[*]` means any number of cycles, unbounded. It is fine for a quick
simulation check and dangerous everywhere else: in formal it can stall a
proof, and in simulation it waves through slow responses. Prefer a real bound
from the spec. The operators deep dive covers the repetition family
(`[*n]`, `[=n]`, `[->n]`) in full.

## Common property shapes

Copy these and change the signal names. They cover most of what a block-level
testbench needs.

```systemverilog
// 1. bounded response: ack within 1 to 4 cycles of req
assert property (@(posedge clk) req |-> ##[1:4] ack);

// 2. handshake stability: while valid waits for ready, data must not move
assert property (@(posedge clk) disable iff (!rst_n)
  valid && !ready |=> $stable(data));
assert property (@(posedge clk) disable iff (!rst_n)
  valid && !ready |=> valid);   // valid itself must hold too

// 3. mutual exclusion: never two grants at once
assert property (@(posedge clk) $onehot0(gnt_vec));

// 4. no X on a valid transaction
assert property (@(posedge clk) valid |-> !$isunknown(data));

// 5. request lines are one-hot whenever any request is active
assert property (@(posedge clk) (|req_vec) |-> $onehot(req_vec));

// 6. reset values: control outputs come out of reset in the known state
assert property (@(posedge clk) $rose(rst_n) |-> (state == IDLE));
```

Shape 6 uses `$rose(rst_n)` to catch the first cycle out of reset. I put
reset-value checks on every control output; they are cheap and they catch the
bugs that only show up in gate-level sims.

## Cover properties

`cover property` does not check anything. It records that a scenario happened,
which gives you two things: functional coverage numbers, and proof that your
assert antecedents can actually fire (no vacuous passes).

```systemverilog
// did the bounded ack scenario ever occur?
cover property (@(posedge clk) req ##[1:4] ack);
// did we ever see back-to-back requests?
cover property (@(posedge clk) req ##1 req);
// did a full 4-beat burst complete?
cover property (@(posedge clk) burst_start ##1 valid[*4]);
```

My rule: every non-trivial assert gets a matching cover on its antecedent.
If the cover count is zero at the end of the regression, the assert is
decoration.

## Action blocks and severity

The `else` branch runs when the property fails. Pick the severity on purpose:

```systemverilog
assert property (p) else $error("...");    // prints, simulation continues
assert property (p) else $warning("...");  // prints, for suspicious but legal behavior
assert property (p) else $fatal(1, "...");  // prints and stops the run
```

I use `$error` for real rule violations, `$warning` for things I want to
eyeball in the log (like a FIFO crossing 90 percent full), and `$fatal` only
when continuing is pointless, for example a lost clock. A pass action exists
too (`assert property (p) $display("hit"); else ...`) but I rarely use it;
cover properties do that job better.

## Debugging: why did it pass (or fail)?

When an assertion fails, check these in order:

1. **The clock and reset.** Wrong edge, or a missing `disable iff`, explains
   most false failures.
2. **Sampling.** Concurrent assertions see preponed values, so a signal that
   glitches between edges is invisible to them. If the waveform shows a
   one-delta glitch, the assertion never saw it.
3. **The antecedent.** For a failure, confirm the antecedent actually fired on
   the failing cycle. For a suspicious pass, confirm it ever fired at all
   (cover property).

When an assertion passes and you do not trust it:

1. Check the cover on the antecedent. Zero hits means vacuous.
2. Force the failure in a directed test: break the rule on purpose and confirm
   the assert fires. An assert you have never seen fail is an assert you have
   never tested.

## Rules of thumb I use

* Name every property. `p_req_ack_latency` is debuggable; an inline anonymous
  property is not.
* `disable iff` on every property, matching the real reset. No exceptions.
* One clock per property until I have a reason for two.
* Every non-trivial assert gets a matching cover on its antecedent.
* I do not trust an assert until I have broken the rule on purpose in a
  directed test and watched it fire.
* `|->` for same-cycle, `|=>` for next-cycle. When in doubt I rewrite as
  `|-> ##1` and check the timing by hand.

## Interview angle

What interviewers actually probe on SVA basics, and the answer they want:

* **"`|->` vs `|=>`?"** Overlapping starts the consequent the same cycle;
  non-overlapping starts it the next cycle. Then give the handshake example
  without being asked: `valid && !ready |=> $stable(data)`.
* **"What is a vacuous pass?"** The implication passes because the antecedent
  never fired. They want to hear that you check antecedent coverage with
  cover properties.
* **"Where do concurrent assertions sample?"** The preponed region, at the
  start of the clock tick. Bonus points: that is why glitches between edges
  are invisible to them.
* **"What does `disable iff` do?"** Disables the assertion while the reset
  condition holds. They are checking that you handle reset, so mention
  matching the real reset polarity.
* **"Immediate vs concurrent?"** Immediate is a procedural check inside an
  always block; concurrent spans time and needs a clock. Give one example of
  each.

## Quick tips

* Concurrent assertions sample in the preponed region, so glitches between
  clock edges are invisible to them. That is usually what you want.
* `$past` defaults to one cycle. Pass an explicit number when you mean more.
* Every property in a testbench file still needs a clock and a disable iff.
* Name your properties. `p_req_ack_latency` is debuggable; an inline anonymous
  property is not.
