---
title: Formal-Ready Assertions
track: sva
level: advanced
---

# Formal-Ready Assertions

A property that passes in simulation can still be useless for formal tools.
This note covers what makes an assertion formal friendly: bounded state, clean
reset behavior, and helper logic a solver can actually reason about.

## Simulation thinking vs formal thinking

Simulation checks the traces your stimulus happens to produce. Formal checks
every trace the environment allows. That one difference drives everything in
this note:

* In simulation, an unbounded wait is convenient; in formal, it can mean the
  proof never terminates.
* In simulation, your testbench constrains the inputs; in formal, every legal
  input combination is explored, including ones you never thought to drive.
  That is why environment constraints become explicit `assume` properties.
* In simulation, a helper counter is just debug logic; in formal, it is state
  the solver must explore, so it has to be minimal, synchronous, and reset.

Write each property as if an adversary will try to break it with the one input
sequence you forgot. In formal, that adversary is real.

## What formal tools need from you

Formal verification explores all reachable states, so anything that inflates
the state space or introduces unbounded behavior makes proofs harder or
impossible. An assertion is formal friendly when it has a clock and a
`disable iff` tied to the real reset, every unbounded construct has a bound,
it never samples combinational loops or undriven nets, and it reads helper
state that updates on the same clock.

## Bounded waits beat unbounded waits

In simulation, `[*1:$]` is a convenient "wait as long as it takes". In formal,
an unbounded wait can mean the tool never terminates the proof attempt.

```systemverilog
// simulation friendly, formal hostile
property p_unbounded;
  @(posedge clk) disable iff (!rst_n)
    req ##1 !ack [*1:$] ##1 ack |-> done;
endproperty
// formal friendly: encode the real protocol bound
property p_bounded;
  @(posedge clk) disable iff (!rst_n)
    req ##1 !ack [*1:16] ##1 ack |-> done;
endproperty
```

Get the bound from the spec (max latency of the responder). If the spec says
"eventually", ask for the number. A bound that matches the design intent is a
stronger check anyway: it catches slow responses an unbounded property waves
through.

## Reset behavior: model what the silicon does

The `disable iff` gate must match the real reset, including polarity and type:

```systemverilog
// active-low async reset
assert property (@(posedge clk) disable iff (!rst_n) a |-> b);
// active-high synchronous reset: gate on the reset level
assert property (@(posedge clk) disable iff (rst) a |-> b);
```

Keep the gate a simple signal or a simple expression on the real reset. A
gate built from derived logic forces the solver to unroll that logic on every
property, and a gate on the wrong polarity gives false failures you will chase
for a day.

Formal starts from the reset state, so reset-value checks are nearly free and
very effective. I assert the reset value of every control output:

```systemverilog
// the FSM really does come out of reset in IDLE
assert property (@(posedge clk) $rose(rst_n) |-> (state == IDLE));
```

## Helper checker: the FIFO occupancy counter

Some properties need state the RTL does not expose. Model it with a small
helper checker that mirrors the protocol.

```systemverilog
module fifo_checker #(
  parameter int DEPTH = 16
)(
  input logic clk, rst_n, push, pop, full, empty
);
  logic [$clog2(DEPTH+1)-1:0] count;
  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n)
      count <= '0;
    else begin
      unique case ({push && !full, pop && !empty})
        2'b10:   count <= count + 1'b1;
        2'b01:   count <= count - 1'b1;
        default: count <= count;
      endcase
    end
  end
  assert property (@(posedge clk) disable iff (!rst_n)
    (count == DEPTH) |-> full);
  assert property (@(posedge clk) disable iff (!rst_n)
    (count == 0) |-> empty);
  assert property (@(posedge clk) disable iff (!rst_n)
    (count < DEPTH) |-> !full);
endmodule
```

Bind this module to the FIFO in the testbench. The checker is plain RTL, so
the formal tool handles it natively and the properties stay simple. Keep
helper logic minimal: one counter, one state machine, nothing more.

## Helper pattern: the outstanding-request tracker

The same idea generalizes to any request/response protocol. Count what is
outstanding and check the interface rules against the count:

```systemverilog
module req_tracker #(
  parameter int MAX_OUT = 8
)(
  input logic clk, rst_n, req, ack
);
  logic [$clog2(MAX_OUT+1)-1:0] outstanding;
  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n)
      outstanding <= '0;
    else begin
      unique case ({req, ack})
        2'b10:   outstanding <= outstanding + 1'b1;
        2'b01:   outstanding <= outstanding - 1'b1;
        default: outstanding <= outstanding;
      endcase
    end
  end
  // no new request when the pipeline is full
  assert property (@(posedge clk) disable iff (!rst_n)
    (outstanding == MAX_OUT) |-> !req);
  // no completion with nothing outstanding
  assert property (@(posedge clk) disable iff (!rst_n)
    (outstanding == 0) |-> !ack);
endmodule
```

This catches the two protocol bugs simulation usually misses: the requester
overrunning the responder, and phantom completions. I write a tracker like
this before I write any latency property on the same interface.

## Avoid long $past chains

`$past(sig, 10)` is easy to write and expensive to prove: the tool must track
ten cycles of history for that signal. Prefer an explicit shift register that
carries the value forward.

```systemverilog
// costly: ten cycles of implicit history
assert property (@(posedge clk) trig |-> ##10 (out == $past(in, 10)));
// cheaper: pipeline the value in helper logic
logic [7:0] pipe [10];
always_ff @(posedge clk) begin
  pipe[0] <= in;
  for (int i = 1; i < 10; i++) pipe[i] <= pipe[i-1];
end
assert property (@(posedge clk) trig |-> ##10 (out == pipe[9]));
```

The helper version makes the state explicit, which helps both the solver and
the next engineer who reads the code. As a rule I keep `$past` depths to 2 or
3; anything deeper becomes a shift register.

## X values: the silent proof killer

An x in the cone of a property can make a proof meaningless: comparisons
against x fail, and undriven nets give the solver freedom that does not exist
in silicon. Before blaming the tool, check the X sources:

```systemverilog
// every signal the property depends on must be known when sampled
assert property (@(posedge clk) disable iff (!rst_n)
  valid |-> !$isunknown({data, addr}));
```

Usual suspects: uninitialized memories in the cone, undriven bits of a wide
bus, and configuration inputs left floating in the formal testbench. I treat
every X source as a bug until proven otherwise: either drive it, reset it, or
constrain it with an assume.

## Liveness style properties

Safety properties ("nothing bad happens") are the bread and butter of formal.
Liveness ("something good eventually happens") needs a bound, or the tool can
stall on a pathological trace.

```systemverilog
// every request is granted within the arbitration bound
assert property (@(posedge clk) disable iff (!rst_n)
  req |-> ##[1:32] gnt);
// starvation freedom, written as a checkable bound
assert property (@(posedge clk) disable iff (!rst_n)
  req [*8] |-> ##[1:32] gnt);
```

The second property encodes starvation freedom directly: eight straight cycles
of request force a grant within the bound. That is checkable; "eventually" on
its own is not.

One caution: encode the bound from what the design actually guarantees. If
the arbiter is round robin over N requesters, the worst case is N-1 other
grants first, so the bound follows from N. Do not assume fairness the RTL
does not implement; an assume that invents fairness proves a design you do
not have.

## assume vs assert

In a formal testbench, `assume` constrains the environment and `assert` checks
the design. Mixing them up is the most common formal bug.

```systemverilog
// assume the driver follows the protocol (environment behavior)
assume property (@(posedge clk) disable iff (!rst_n)
  valid && !ready |=> valid);
// assert the device responds to legal stimulus (design behavior)
assert property (@(posedge clk) disable iff (!rst_n)
  valid && ready |=> ##[1:4] resp_valid);
```

Rules: assume inputs and environment behavior, never assume a DUT output.
Assert DUT outputs and internal invariants. Fair game for assumes: input
protocol rules (valid stability from the driver), reset behavior, tied-off
configuration straps, and clock relationships. Off limits: anything the
design itself must guarantee.

The symptom of an overconstrained assume is a suspiciously green run: every
assert passes and every cover is zero. The environment was constrained so
tightly that nothing interesting could happen. The fix is to cover the
environment behavior too, not just the design.

## Cover properties: prove your antecedents can fire

If a proof passes vacuously, the usual cause is an overconstrained assume or
an antecedent that can never fire: check antecedent coverage.

```systemverilog
// prove the request can actually arrive and be granted
cover property (@(posedge clk) disable iff (!rst_n)
  req ##[1:32] gnt);
// prove the FIFO can really fill, or the full flag is decorative
cover property (@(posedge clk) disable iff (!rst_n)
  full);
```

I want a cover on every assert antecedent and on every interesting helper
state (counter at max, tracker full, FSM in each state). In formal, a cover
that never hits means either the design cannot reach that state, which is a
finding, or the environment is overconstrained, which is a testbench bug.
Either way I want to know.

## Keep helper logic out of synthesis

Checker modules belong in a separate bind file, wrapped so synthesis never
sees them:

```systemverilog
// synthesis translate_off
bind dut fifo_checker #(.DEPTH(16)) u_fifo_check (
  .clk   (clk),
  .rst_n (rst_n),
  .push  (wr_en),
  .pop   (rd_en),
  .full  (full),
  .empty (empty)
);
// synthesis translate_on
```

And the helper itself stays in the synthesizable subset: flops, combinational
logic, reset on every flop, no delays, no file I/O. If the helper is not
something you could tape out, the formal tool is reasoning about a model you
do not have.

## Checklist before handing properties to the formal tool

1. Every property has a clock and `disable iff` on the real reset.
2. No unbounded operators without a justification and a bound.
3. Helper state is minimal, synchronous, and reset.
4. Assumes constrain the environment; asserts check the design.
5. Antecedents are reachable (run a quick cover check).
6. `$past` depths are small; deep history is an explicit shift register.
7. No X sources in the cone of any property.
8. Helper checkers are bound, not inlined, and excluded from synthesis.

## Rules of thumb I use

* I get the bound from the spec. If the spec says "eventually", I ask for the
  number before I write the property.
* One helper, one job. A checker module that grows a second state machine
  gets split.
* I write the tracker before the latency property. Interface rules first,
  timing second.
* `$past` deeper than 3 becomes a shift register. No debate.
* A green formal run with zero covers is a red run. I check covers before I
  celebrate.
* I never assume a DUT output. If I catch myself doing it, the property is
  really an assert on the driver, and I rewrite it.

## Interview angle

What interviewers actually probe on formal, and the answer they want:

* **"`assume` vs `assert`?"** Assume constrains the environment (inputs,
  driver protocol); assert checks the design (outputs, invariants). Never
  assume a DUT output. Give the valid-stability example.
* **"Your formal run is all green but you do not trust it. What do you
  check?"** Vacuity: overconstrained assumes or unreachable antecedents.
  Check cover properties on the antecedents.
* **"Why are unbounded waits bad for formal?"** The solver may never
  terminate the proof attempt; also, a bound from the spec is a stronger
  check because it catches slow responses.
* **"What makes a property hard to prove?"** Deep `$past` chains (implicit
  history), wide datapaths in the property (keep properties on control;
  abstract the data), unbounded operators, and large helper state.
* **"How do you check a FIFO formally?"** Helper occupancy counter bound to
  the DUT, then simple properties on the count: full when count is max,
  empty when count is zero.
