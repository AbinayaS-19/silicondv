---
title: RTL Coding Patterns
track: sv
level: intermediate
---

# RTL Coding Patterns

Reusable structures that show up in almost every design: FIFOs, FSMs, clock
domain crossing, and resets. Learn these once and you will recognize them
everywhere.

## Synchronous FIFO structure

A sync FIFO is a memory with read and write pointers. Full and empty come from
comparing the pointers.

```systemverilog
module sync_fifo #(
  parameter int WIDTH = 32,
  parameter int DEPTH = 16
)(
  input  logic             clk,
  input  logic             rst_n,
  input  logic             wr_en,
  input  logic [WIDTH-1:0] wr_data,
  input  logic             rd_en,
  output logic [WIDTH-1:0] rd_data,
  output logic             full,
  output logic             empty
);
  localparam int AW = $clog2(DEPTH);
  logic [WIDTH-1:0] mem [DEPTH];
  logic [AW-1:0] wr_ptr, rd_ptr;
  logic [AW:0]   count;  // one extra bit so full != empty
  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      wr_ptr <= '0;
      rd_ptr <= '0;
      count  <= '0;
    end else begin
      if (wr_en && !full) begin
        mem[wr_ptr] <= wr_data;
        wr_ptr <= wr_ptr + 1'b1;
      end
      if (rd_en && !empty) begin
        rd_ptr <= rd_ptr + 1'b1;
      end
      unique case ({wr_en && !full, rd_en && !empty})
        2'b10:   count <= count + 1'b1;
        2'b01:   count <= count - 1'b1;
        default: count <= count;
      endcase
    end
  end
  assign rd_data = mem[rd_ptr];
  assign full    = (count == DEPTH);
  assign empty   = (count == '0);
endmodule
```

Notes on this structure:

* **Read timing.** `rd_data` is combinational from `rd_ptr`, so the head
  entry is visible whenever the FIFO is not empty, without needing `rd_en`
  first. If your consumer expects data to appear after `rd_en`, register
  `rd_data` and shift the empty timing by a cycle; just be explicit about
  which convention the interface uses.
* **Simultaneous read and write.** Both pointer updates are independent `if`
  statements, and the `count` case handles the both-active case with
  `default: count <= count`. A same-cycle push and pop leaves occupancy
  unchanged, which is exactly right.
* **DEPTH must be a power of two.** The pointers are `AW = $clog2(DEPTH)`
  bits wide and wrap modulo 2^AW. For a non-power-of-two DEPTH they would
  address entries past the end of `mem`.
* **Extensions.** `almost_full = (count >= DEPTH-2)` and
  `almost_empty = (count <= 2)` are one-liners on the same count and are how
  upstream backpressure usually starts.

## FSM styles: two always blocks

The standard pattern is one `always_ff` for the state register and one
`always_comb` for next state and outputs. Mealy outputs depend on state and
inputs; Moore outputs depend on state only.

```systemverilog
typedef enum logic [1:0] {IDLE, REQ, WAIT_ACK, DONE} state_t;
state_t state, next_state;
always_ff @(posedge clk or negedge rst_n) begin
  if (!rst_n) state <= IDLE;
  else        state <= next_state;
end
always_comb begin
  next_state = state;
  gnt = 1'b0;   // default: Moore style, overridden per state
  unique case (state)
    IDLE:     if (req)            next_state = REQ;
    REQ:      begin
                gnt = 1'b1;       // Mealy style: depends on req too
                if (ack)          next_state = DONE;
                else              next_state = WAIT_ACK;
              end
    WAIT_ACK: if (ack)            next_state = DONE;
    DONE:     next_state = IDLE;
  endcase
end
```

Defaults at the top of the `always_comb` block prevent inferred latches and
make the intent obvious. One-hot encoding is a synthesis option, not a coding
style decision; let the tool choose.

|              | Mealy                              | Moore                              |
| ------------ | ---------------------------------- | ---------------------------------- |
| Output depends on | State and inputs                | State only                         |
| Response     | Faster (same cycle as the input)   | One cycle later, cleaner timing     |
| Risk         | Input glitches can reach the output| Extra state or cycle of latency    |

Two more things I do on every FSM:

* **Registered outputs for timing.** A Moore output registered once more
  (`gnt_q <= gnt`) gives the cleanest timing boundary at the block edge. Mealy
  outputs straight to another block's input are how long combinational paths
  are born.
* **Illegal states.** `unique case` over an enum tells the tool only legal
  values occur. If the FSM is safety critical, drop `unique`, add
  `default: next_state = IDLE;`, and let synthesis build the recovery. For
  everything else, the enum plus `unique` is enough.

## The valid/ready handshake

This is the interface pattern behind AXI-style streaming, and interviewers
love it. One side offers data with `valid`; the other accepts with `ready`.
The transfer happens on the cycle both are high.

```systemverilog
// source side: hold valid and data until the handshake completes
always_ff @(posedge clk or negedge rst_n) begin
  if (!rst_n) begin
    src_valid <= 1'b0;
    src_data  <= '0;
  end else if (!src_valid || dst_ready) begin
    // idle, or handshake just completed: may present new data
    src_valid <= has_data;
    src_data  <= next_data;
  end
  // else: hold src_valid and src_data steady
end
```

The rules, which are the whole protocol:

1. Once `valid` is asserted, it must stay asserted until the handshake
   (`valid && ready`). Dropping `valid` early is a protocol violation.
2. While `valid` is high and `ready` is low, `data` must not change.
3. `ready` may assert or deassert at any time; deasserting it just stalls.
   It should not depend combinationally on `valid` across a module boundary,
   or you build a combinational loop through the handshake.
4. Backpressure is free: the sink stalls by holding `ready` low, and the
   source holds its data without any extra buffering.

The matching assertions are two lines (see the SVA cheat sheet): valid
stability and data stability while waiting for ready.

## Pipelining without breaking the protocol

Adding pipeline stages is a shift register on data plus a matching shift
register on `valid`. The valid bits are what make it a pipeline instead of a
delay line: a low valid is a bubble, and bubbles flow through like data.

```systemverilog
// two-stage pipeline: data moves, valid tracks it
always_ff @(posedge clk or negedge rst_n) begin
  if (!rst_n) begin
    v_d1 <= 1'b0;
    v_d2 <= 1'b0;
    d_d1 <= '0;
    d_d2 <= '0;
  end else begin
    v_d1 <= v_in;   d_d1 <= d_in;
    v_d2 <= v_d1;   d_d2 <= d_d1;
  end
end
assign v_out = v_d2;
assign d_out = d_d2;
```

Latency goes up by the number of stages; throughput stays one per cycle.
Every pipeline bug I have debugged was a valid bit that did not travel with
its data: stall it, flush it, or gate it, but move it in the same always_ff
as the data it describes.

## CDC: the two-flop synchronizer

A single bit crossing clock domains goes through two back-to-back flops in the
destination domain. This does not remove metastability; it gives the first flop
a full cycle to settle so the second flop samples a stable value.

```systemverilog
module sync_2ff (
  input  logic clk_dst,
  input  logic rst_n,
  input  logic d_in,   // from the source domain
  output logic d_out
);
  logic sync_0, sync_1;
  always_ff @(posedge clk_dst or negedge rst_n) begin
    if (!rst_n) begin
      sync_0 <= 1'b0;
      sync_1 <= 1'b0;
    end else begin
      sync_0 <= d_in;
      sync_1 <= sync_0;
    end
  end
  assign d_out = sync_1;
endmodule
```

Rules: only single bits go through this. Buses need a handshake, a FIFO, or
gray coding (covered in the advanced note). Never put combinational logic
between the two flops, and constrain the path with a max delay in SDC.

Three practical details that separate working silicon from simulations:

* **Keep the flops together.** Many teams tag synchronizer flops with an
  `ASYNC_REG` attribute so the tool places them adjacently and does not
  optimize or replicate them.
* **Constrain it.** A `set_max_delay -datapath_only` on the synchronizer path
  tells timing analysis what the structure is for; without it the path gets
  analyzed as ordinary logic and either fails or gets "fixed" into something
  that breaks the intent.
* **Reset consistently.** Reset both flops to a known value. An X on the
  synchronizer output at power-up is a CDC bug that only shows up in
  gate-level sims.

## CDC: pulses and buses

A pulse is not a level, so the two-flop synchronizer alone can swallow it:
if the pulse is narrower than the destination clock period, the first flop
may never see it. The standard fix is a toggle synchronizer.

```systemverilog
// source domain: turn the pulse into a toggling level
always_ff @(posedge clk_src or negedge rst_n) begin
  if (!rst_n) tgl_src <= 1'b0;
  else if (pulse_src) tgl_src <= ~tgl_src;
end
// destination domain: sync the level, then edge-detect it
always_ff @(posedge clk_dst or negedge rst_n) begin
  if (!rst_n) begin
    t0 <= 1'b0;
    t1 <= 1'b0;
    t2 <= 1'b0;
  end else begin
    t0 <= tgl_src;
    t1 <= t0;
    t2 <= t1;
  end
end
assign pulse_dst = t1 ^ t2;  // one-cycle pulse in the destination domain
```

The toggle is a level, so the two-flop synchronizer handles it, and the XOR
turns each toggle back into a one-cycle pulse. Constraint: source pulses must
arrive at least a couple of destination clock periods apart, or toggles merge
and pulses get lost. If pulses can arrive back to back, use a handshake or an
async FIFO instead.

For multi-bit buses there are three options, in order of preference:

1. **Async FIFO.** The heavy-duty answer: dual-port memory, gray-coded read
   and write pointers crossing domains, full/empty generated in each domain.
   Use it for data streams.
2. **Handshake.** Source puts data on the bus, raises `req` (synced over),
   destination raises `ack` (synced back), source may change the bus only
   after `ack`. Slow but simple and obviously correct.
3. **Gray code.** For counters crossing domains: gray code changes one bit
   per increment, so a sampled transitional value is at most one count off,
   never garbage. This is what async FIFO pointers use internally.

What never works: syncing each bus bit through its own two-flop chain. The
bits settle on different cycles and the destination samples a mix of old and
new values.

## Reset strategies

Async assert, sync deassert is the industry default for a reason: the reset
asserts immediately regardless of the clock, and deasserts cleanly on a clock
edge so there is no recovery violation.

```systemverilog
// reset synchronizer: async assert, sync release
always_ff @(posedge clk or negedge rst_n_in) begin
  if (!rst_n_in) begin
    rst_sync_0 <= 1'b0;
    rst_sync_1 <= 1'b0;
  end else begin
    rst_sync_0 <= 1'b1;
    rst_sync_1 <= rst_sync_0;
  end
end
assign rst_n = rst_sync_1;
```

Every flop in the design uses the synchronized reset with `or negedge rst_n`
in the sensitivity list. Keep the reset tree in mind at the top level: a reset
that fans out to the whole chip needs buffering, which is a physical design
concern, but the RTL pattern above is where it starts.

|                        | Async reset                              | Sync reset                              |
| ---------------------- | ---------------------------------------- | --------------------------------------- |
| Assert                 | Immediate, no clock needed               | On a clock edge                         |
| Deassert               | Must be synchronized (or recovery fails) | Clean by construction                   |
| Flop cost              | Uses the dedicated reset pin             | Uses the data path (extra mux)          |
| Use when               | You need reset without a running clock   | Datapath-heavy blocks, easier timing    |

Resets cross clock domains too: each domain gets its own synchronizer so the
release is clean in that domain. A reset released asynchronously in two
domains at slightly different times is a whole class of intermittent bugs;
one synchronizer per domain kills it.

## Rules of thumb I use

* Two always blocks for every FSM: `always_ff` for state, `always_comb` for
  next state and outputs. Defaults at the top of the `always_comb`.
* One driver per signal. If two blocks want to write it, I have an
  arbitration problem, not a coding problem.
* `<=` in `always_ff`, `=` in `always_comb`. I check this in every review,
  including my own.
* Valid bits travel with their data, in the same always_ff. Every pipeline
  bug I have debugged was a valid bit left behind.
* Single bits get the two-flop synchronizer; everything wider gets a FIFO, a
  handshake, or gray code. Bit-by-bit syncing of a bus is never the answer.
* Async assert, sync deassert, one synchronizer per clock domain.
* FIFO DEPTH is a power of two. The pointer math assumes it.
* I do not trust a handshake until I have seen backpressure in the waveform:
  hold `ready` low for a while and confirm data and valid hold still.

## Interview angle

What interviewers actually probe on RTL patterns, and the answer they want:

* **"How do you compute full and empty in a FIFO?"** Compare read and write
  pointers, but the pointers alone cannot distinguish full from empty, so
  either keep an occupancy count (one extra bit) or a wrap-around flag bit
  on the pointers. Then explain the simultaneous read/write case.
* **"What does the two-flop synchronizer do, and what does it not do?"**
  It gives the first flop a full cycle to resolve metastability so the second
  samples a stable value. It does not remove metastability, and it only works
  for single bits. Buses need gray code, a handshake, or an async FIFO.
* **"Mealy vs Moore?"** Mealy outputs depend on state and inputs (faster,
  same-cycle response); Moore outputs depend on state only (cleaner timing).
  Give the trade, not just the definitions.
* **"What are the valid/ready rules?"** Valid must hold until the handshake;
  data must be stable while valid waits for ready; ready can deassert freely.
  Bonus: no combinational valid-to-ready path across modules.
* **"Async vs sync reset?"** Async asserts without a clock but must
  deassert synchronously (recovery); sync is clean by construction but costs
  data-path muxing and needs a clock to assert. Industry default: async
  assert, sync deassert.
* **"How do you cross a pulse to another clock domain?"** Toggle
  synchronizer: pulse to toggle in the source, two flops in the destination,
  XOR edge detect. Mention the minimum pulse spacing.
