---
title: Advanced RTL
track: sv
level: advanced
---

# Advanced RTL

Async FIFOs, pipelines, arbiters, and the metastability you are actually
protecting against. These are the blocks interviewers ask about and designs
depend on. I have written each of them more than once, debugged each of them
at 2 AM, and this note is the version I wish someone had handed me first.

## Async FIFO internals

An async FIFO moves data between two clock domains. The write pointer lives in
the write domain, the read pointer in the read domain, and each pointer is
synchronized to the other side in gray code so only one bit changes at a time.
If two bits changed at once, the synchronizer could sample a mix of old and
new and hand you a pointer value that never existed. Gray code makes that
impossible.

The full pointer crossing, both directions:

```systemverilog
// binary to gray: one bit changes per increment
function automatic logic [AW:0] bin2gray(logic [AW:0] bin);
  return (bin >> 1) ^ bin;
endfunction

// write side: pointer crosses to the read domain through a 2-flop synchronizer
logic [AW:0] wr_gray, wr_gray_s0, wr_gray_s1;
always_ff @(posedge rd_clk or negedge rd_rst_n) begin
  if (!rd_rst_n) begin
    wr_gray_s0 <= '0;   // no logic between these two flops, ever
    wr_gray_s1 <= '0;
  end else begin
    wr_gray_s0 <= wr_gray;      // first flop can go metastable
    wr_gray_s1 <= wr_gray_s0;   // second flop gets a full cycle to settle
  end
end

// write side: full when write gray pointer equals read gray pointer
// with the top two bits inverted (FIFO is full, one lap ahead)
assign full = (wr_gray == {~rd_gray_sync[AW:AW-1], rd_gray_sync[AW-2:0]});
// read side: empty when the gray pointers are equal
assign empty = (rd_gray == wr_gray_sync);
```

The pointers are one bit wider than the address (`AW+1` bits for `DEPTH`
entries). The extra bit distinguishes full from empty: equal pointers with the
same wrap bit means empty; equal addresses with the wrap bit flipped means
full. Depth must be a power of two for the wrap arithmetic to work.

Where each flag is generated, and why it cannot be anywhere else:

| Flag | Generated in | Compares | Why there |
|---|---|---|---|
| `full` | write domain | local `wr_gray` vs synchronized `rd_gray` | the write side decides whether a write is allowed |
| `empty` | read domain | local `rd_gray` vs synchronized `wr_gray` | the read side decides whether a read is allowed |
| `almost_full` | write domain | pointer difference against a threshold | early warning so the source can stop cleanly |
| `almost_empty` | read domain | pointer difference against a threshold | early warning so the sink can prepare |

Both flags are conservative. `full` can assert when one slot is still free,
and `empty` can assert when one entry is still unread, because the
synchronized pointer lags the real one by two destination clocks. That
pessimism is the price of safety. Never "fix" it by comparing pointers
combinationally across domains.

Reset is a CDC problem too. Assert reset asynchronously, deassert it
synchronously in each domain, and make sure the reset clears the synchronizer
flops as well as the pointers. A synchronizer that comes out of reset holding
a stale gray value will report a phantom full or empty until the pointers lap
it.

Common bugs I have seen in reviews:

* Comparing the raw binary pointers across domains instead of the gray,
  synchronized ones.
* Forgetting the `+1` bit and then wondering why full and empty are
  indistinguishable.
* Synchronizing the data bus instead of the pointers. The RAM itself is
  dual-ported; only the pointers cross.
* Reading `empty` in the write domain or `full` in the read domain. Each flag
  belongs to its domain.

> **Rules of thumb I use:** I size FIFO depth for the worst burst, not the
> average rate. I never let a full or empty flag leave its clock domain. And
> when someone proposes a non power of two depth, I ask what problem that
> solves, because the wrap math stops being free and the answer is usually
> nothing.

**What interviewers ask:** "Why gray code?" The answer they want: only one
bit changes per count, so a synchronizer sampling mid-transition can at worst
deliver the old value or the new value, never a corrupt third value.
Follow-up: "Why must depth be a power of two?" Because the binary pointer
wraps naturally at the depth boundary, which keeps the gray property intact
and makes the full/empty wrap-bit trick work.

## Clock domain crossing patterns

The FIFO is one member of a family. Pick the technique by what crosses and
how often:

| Technique | What crosses | Use when |
|---|---|---|
| 2-flop synchronizer | single-bit level (enable, mode) | signal changes slowly relative to the destination clock |
| Pulse synchronizer | single-cycle pulse | a one-cycle event must survive the crossing |
| Req/ack handshake | multi-bit data, infrequent | you can afford the round trip latency |
| Async FIFO | multi-bit streaming data | continuous throughput between domains |
| Gray-coded pointer | a counter both sides must track | FIFO pointers, credit counters |

The pulse synchronizer, because the naive version (just sync the pulse)
loses pulses when the destination clock is slower:

```systemverilog
// source domain: toggle instead of pulsing, so nothing can be missed
always_ff @(posedge src_clk or negedge src_rst_n) begin
  if (!src_rst_n) toggle <= 1'b0;
  else if (pulse_in) toggle <= ~toggle;  // every pulse flips the level
end

// destination domain: sync the level, then detect edges
always_ff @(posedge dst_clk or negedge dst_rst_n) begin
  if (!dst_rst_n) begin
    s0 <= 1'b0; s1 <= 1'b0; s2 <= 1'b0;
  end else begin
    s0 <= toggle;   // first sync flop
    s1 <= s0;       // second sync flop, settled value
    s2 <= s1;       // one more for edge detection
  end
end
assign pulse_out = s1 ^ s2;  // one-cycle pulse per toggle edge
```

Back to back pulses in the source domain must be spaced wider than the
destination clock period plus sync latency, or the toggle returns to its
starting value before the destination sees it. That spacing requirement is
the part people forget.

> **Rules of thumb I use:** I synchronize control, never data buses. If more
> than one bit needs to cross and stay coherent, it goes through a FIFO or a
> handshake. A bare multi-bit sync is a bug I can spot from across the room.

**What interviewers ask:** "Your 2-flop synchronizer works, but the signal
is a 32-bit bus. What breaks?" The answer: each bit settles independently,
so the destination can sample a mix of old and new bits. Then name the fix
you would actually use: FIFO for streaming, handshake for occasional
transfers, gray code if it is really a counter.

## Pipelining and valid pipelines

Pipelining splits long combinational paths across registers. The valid signal
travels with the data so the consumer knows which stages hold real data.

```systemverilog
// 3-stage pipeline: data and valid shift together
always_ff @(posedge clk or negedge rst_n) begin
  if (!rst_n) begin
    stage0 <= '0; stage1 <= '0; stage2 <= '0;
    valid0 <= 1'b0; valid1 <= 1'b0; valid2 <= 1'b0;
  end else begin
    stage0 <= f0(in_data);
    stage1 <= f1(stage0);
    stage2 <= f2(stage1);
    valid0 <= in_valid;
    valid1 <= valid0;
    valid2 <= valid1;
  end
end
assign out_data  = stage2;
assign out_valid = valid2;
```

Latency is fixed at 3 cycles and throughput is one result per cycle. If the
downstream can stall, you have two choices:

| Approach | Latency | Cost | Use when |
|---|---|---|---|
| Valid-only pipeline, accept bubbles | fixed | almost nothing | downstream stalls are rare or harmless |
| Ready/valid with backpressure | variable | skid buffer, hold logic | every beat matters, no drops allowed |

Gating `valid` is simpler than backpressure and often enough. When it is not,
add a ready signal and a skid buffer: one extra slot that parks a beat when
the downstream stalls, so the upstream never has to deal with a bubble it did
not cause.

```systemverilog
// skid buffer: one extra slot between a producer and a stalling consumer.
// The parked beat always goes out first; a newly arrived beat refills the
// slot the parked beat just freed.
wire out_xfer = out_valid && out_ready;
wire in_xfer  = in_valid && in_ready;

always_ff @(posedge clk or negedge rst_n) begin
  if (!rst_n) begin
    skid_valid <= 1'b0;
    skid_data  <= '0;
  end else if (out_xfer && skid_valid) begin
    // parked beat left: refill the slot if a new beat arrived, else free it
    skid_data  <= in_data;
    skid_valid <= in_xfer;
  end else if (in_xfer && !out_xfer) begin
    // stalled with the slot free: park the new beat
    skid_data  <= in_data;
    skid_valid <= 1'b1;
  end
end
assign in_ready  = out_ready || !skid_valid;   // take new data when downstream takes it, or the slot is free
assign out_valid = skid_valid || in_valid;     // the parked beat goes first
assign out_data  = skid_valid ? skid_data : in_data;
```

The ready/valid contract both sides must honor: `valid` must not depend
combinationally on `ready`; once `valid` is asserted, the data must stay
stable until `ready` arrives; `ready` is allowed to depend on `valid`. Break
the first rule and you get a combinational loop through two modules. Break
the second and the sink samples garbage.

> **Rules of thumb I use:** I keep valid pipelines for fixed-latency datapaths
> and add backpressure only where the spec demands no bubbles. A pipeline
> without a flush path is a debug nightmare, so every pipeline I write has a
> way to drain it, even if the architect swears it will never stall.

**What interviewers ask:** "What is the difference between latency and
throughput here?" Latency is 3 cycles per result, throughput is one result
per cycle. Then: "Downstream stalls for 5 cycles, what happens to your
valid-only pipeline?" Either you drop beats or you were never valid-only.
They want to hear you reach for backpressure deliberately, not by accident.

## Arbiter design

Fixed priority is simple and unfair: the lowest index always wins.

```systemverilog
// fixed priority: req[0] beats everything
always_comb begin
  gnt = '0;
  for (int i = 0; i < N; i++) begin
    if (req[i]) begin
      gnt[i] = 1'b1;
      break;
    end
  end
end
```

Round robin is fair: it remembers who won last and starts the search after
them.

```systemverilog
logic [$clog2(N)-1:0] last_gnt;
always_comb begin
  gnt = '0;
  for (int i = 1; i <= N; i++) begin
    int idx = (last_gnt + i) % N;  // search starts after the last winner
    if (req[idx]) begin
      gnt[idx] = 1'b1;
      break;
    end
  end
end
always_ff @(posedge clk or negedge rst_n) begin
  if (!rst_n)
    last_gnt <= '0;
  else if (|gnt)
    last_gnt <= $clog2(gnt);  // one-hot to index: the set bit's position
end
```

Two details worth knowing. First, `$clog2` of a one-hot value returns the
index of the set bit, which is why the update is one line. Second, updating
`last_gnt` on any grant is fine only if a grant always means the transfer
happened. If your protocol can grant and then not transfer (request drops
mid-arbitration), update on the accepted transfer instead, or one client can
steal rotation turns it never uses.

Choose fixed priority when one client is genuinely urgent (an interrupt
controller). Choose round robin when clients are peers and starvation is a bug
(a bus arbiter). Document the choice; "fair" and "simple" are both valid, but
only on purpose.

For multi-cycle transfers, add grant hold: once a winner starts, keep its
grant asserted until it signals done, and freeze the round robin pointer.
Without the hold, a long transfer gets chopped into one-cycle slices and the
client logic turns into spaghetti.

> **Rules of thumb I use:** I write the fixed priority version first even when
> I need round robin, because it is the reference the fair version gets
> checked against. I define fairness before I code it: equal clients get equal
> turns over a bounded window, and I can point at the window in the testbench.

**What interviewers ask:** "Show me starvation in the fixed priority
arbiter." Request 0 held high forever, request 3 never grants. Then: "Fix it
without full round robin." Answers they accept: a starvation counter that
boosts priority after N denied cycles, or a rotating priority mask. They are
checking whether you think about fairness as a mechanism, not a vibe.

## Metastability basics

When a flop samples a changing input, its output can hover between 0 and 1 for
a while before resolving. That is metastability. You cannot prevent it; you
contain it.

What actually matters:

* Mean time between failures (MTBF) grows exponentially with the settling time
  you allow. One extra destination-domain cycle between synchronizer stages
  buys orders of magnitude.
* The synchronizer flops must be placed close together with no logic between
  them. Mark them with a synthesis attribute (e.g. `ASYNC_REG`) so the tool
  does not optimize them away or move them apart.
* Synchronize control signals, not data buses. For buses use a FIFO, a
  handshake with synchronized request/acknowledge, or gray-coded pointers.
* Reset crossing is a CDC problem too. A reset deasserting near a clock edge in
  another domain needs the same treatment as any async signal.
* Tell the timing tool about the crossing. Synchronizer paths get a false path
  or max-delay exception in the constraints; without it, the tool either
  screams about unmeetable timing or, worse, "fixes" your synchronizer.

A two-flop synchronizer is the default for a reason: every extra destination-domain
cycle of settling time multiplies MTBF exponentially, so with ordinary flop
parameters the numbers land so far in your favor that metastability stops being
the practical worry. I quote the curve, not a number, because the exact MTBF
depends on your clock period, toggle rate, and the flop's own parameters. That
is why the pattern in the intermediate note is the default: it is simple, and
the math is overwhelmingly on its side.

One more thing people get wrong: metastability is not the only CDC failure.
The more common one in practice is data incoherence (the bus-mix problem
above) and the second is reset sequencing. When a CDC bug escapes, bet on
coherence first, reset second, raw metastability last.

> **Rules of thumb I use:** Two flops is the default, three when the
> destination clock is fast or the source toggles often. I treat every reset
> that crosses a domain as guilty until proven innocent. And I never trust a
> CDC structure I have not seen in a CDC report from the actual tool.

**What interviewers ask:** "Can you eliminate metastability?" No. You give it
time to resolve and you keep the possibly-metastable node from fanning out to
logic that matters. If they push: the first flop may go metastable, the
second one samples it a full cycle later, and the exponential MTBF curve does
the rest. They want the word "contain", not "prevent".
