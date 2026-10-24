---
title: SystemVerilog Essentials
track: sv
level: beginner
---

# SystemVerilog Essentials

The subset of SystemVerilog you actually use every day in RTL and testbenches.
Nothing here is exotic; it is the foundation everything else builds on.

## logic vs reg vs wire

In SystemVerilog, `logic` is the single data type you should reach for first.
It can be driven by one procedural block or one continuous assignment, and it
replaces both `reg` and `wire` in most code.

```systemverilog
logic        clk;          // 1 bit
logic [7:0]  data;         // 8 bit vector, [7] is the MSB
logic [3:0][7:0] mem;     // unpacked array of 4 bytes
```

`reg` and `wire` still exist for backward compatibility, but new code has no
reason to use them. One exception: a net driven by multiple continuous
assignments (like a tristate bus) still needs a `wire` or `tri`, because
`logic` allows only a single driver.

### bit vs logic: 2-state vs 4-state

|            | `bit`                        | `logic`                          |
| ---------- | ---------------------------- | -------------------------------- |
| States     | 2-state: 0, 1                | 4-state: 0, 1, x, z              |
| x handling | x decays to 0                | x propagates                     |
| Use in     | Testbenches, for speed       | RTL, so X bugs stay visible       |

In RTL I always use `logic`: if something goes X, I want to see it, not have
it silently become 0. In testbenches `bit` is fine and simulates faster.

## Numbers and literals

```systemverilog
logic [7:0] a = 8'hA5;    // sized hex: 8 bits, value A5
logic [3:0] b = 4'b1010;  // sized binary
int         c = 32'd100;  // sized decimal (int is 32-bit anyway)
logic [7:0] d = '0;       // fill all bits with 0, any width
logic [7:0] e = '1;       // fill all bits with 1 (FF here)
logic [7:0] f = 'x;       // fill all bits with x
```

`'0`, `'1`, `'x`, and `'z` fill to the width of whatever they are assigned
to, which makes them perfect for resets and defaults. Unsized numbers like
`100` default to 32-bit signed integers, so size your literals in RTL;
`8'd5 + 8'd200` wraps at 8 bits, and that is usually what you want the reader
to see.

## Operators you will use daily

| Category     | Operators              | Notes                                                        |
| ------------ | ---------------------- | ------------------------------------------------------------ |
| Arithmetic   | `+ - * / % **`         | Watch widths; multiplication doubles the width               |
| Relational   | `< <= > >=`            |                                                              |
| Equality     | `== !=`                | Returns x if either side has x                               |
| Case equality| `=== !==`              | Compares x and z literally; safe in testbench checks         |
| Logical      | `! && \|\|`            | Treat the whole operand as true/false                        |
| Bitwise      | `~ & \| ^ ~^`          | Operate bit by bit                                           |
| Reduction    | `& \| ^` (unary)       | `&req_vec` is 1 if all bits are 1                            |
| Shift        | `<< >>`                | Logical shifts; `>>>` is arithmetic (sign extending)          |
| Concat       | `{a, b}`               | `{hdr, payload}` builds a wider vector                       |
| Replicate    | `{4{a}}`               | `{8{1'b0}}` is 8 zero bits                                   |

Two that deserve emphasis:

* `==` vs `===`: in RTL, `==` returning x on x input is correct behavior (the
  comparison is genuinely unknown). In a testbench self-check, use `===` or
  `!==` so an x in the DUT output fails loudly instead of vanishing.
* `{a, b}` concatenation and `{n{...}}` replication build vectors without a
  single magic number. `{2'b0, addr}` reads better than any comment.

## Blocking vs nonblocking assignments

This is the single most interviewed topic in SystemVerilog, and the rule is
short:

```systemverilog
always_comb begin
  y = a & b;   // blocking: updates immediately, like software
end
always_ff @(posedge clk) begin
  q <= d;      // nonblocking: updates at the end of the timestep
end
```

|                              | Blocking `=`                  | Nonblocking `<=`                    |
| ---------------------------- | ----------------------------- | ----------------------------------- |
| When the update happens      | Immediately, in order         | End of the timestep (NBA region)    |
| Reads later in the same block| See the new value             | See the old value                   |
| Use in                       | `always_comb`, functions      | `always_ff`                         |

Why it matters: with `<=` in an `always_ff`, every flop in the block samples
the old values simultaneously, which is exactly what hardware does. With `=`
in an `always_ff`, statements execute in order like software, and two flops
can race each other in simulation while the synthesized hardware does
something else. Never mix `=` and `<=` to the same variable in one block.

## always_comb, always_ff, always_latch

These three say what the block is for, and the compiler checks you mean it.

```systemverilog
// combinational: every input assigned, no storage inferred
always_comb begin
  next_state = state;
  case (state)
    IDLE: if (start) next_state = RUN;
    RUN:  if (done)  next_state = IDLE;
  endcase
end
// sequential: clocked, nonblocking assignments
always_ff @(posedge clk or negedge rst_n) begin
  if (!rst_n)
    state <= IDLE;
  else
    state <= next_state;
end
```

Rules that keep you out of trouble:

* `always_comb`: assign every output on every path, or you infer a latch.
* `always_ff`: use nonblocking `<=` only.
* `always_latch`: avoid it unless you truly mean a latch. If you see a latch
  warning on an `always_comb`, something is unassigned.

### always_comb vs always @(*)

|                                  | `always_comb`                          | `always @(*)`                        |
| -------------------------------- | -------------------------------------- | ------------------------------------ |
| Sensitivity                      | Automatic, including signals read inside called functions | Automatic, but misses signals read inside called functions |
| Multiple drivers                 | Compile error if written elsewhere     | Silent race                          |
| Intent                           | "This is combinational logic"          | Old Verilog idiom                    |

Use `always_comb` and forget `always @(*)` exists. The function-call case is
the real trap: `always @(*)` does not add signals read inside a function the
block calls, so the block silently misses updates.

## unique vs priority

On a case statement, `unique` tells the compiler the branches are mutually
exclusive and one of them will match. `priority` says evaluate in order and
at least one will match. Both turn silent priority encoders into checked
intent.

```systemverilog
always_comb begin
  unique case (sel)
    2'b00: y = a;
    2'b01: y = b;
    2'b10: y = c;
    2'b11: y = d;
  endcase
end
```

Without `unique`, overlapping or missing cases synthesize quietly and you find
out in the lab. With it, violations are reported. `unique if` and
`priority if` exist for if-else chains and follow the same idea.

## Packed vs unpacked arrays

Packed dimensions come before the name and behave as one vector. Unpacked
dimensions come after the name and are an array of separate elements.

```systemverilog
logic [7:0] packed_vec;      // one 8-bit vector, you can slice it
logic [7:0] unpacked_arr [4]; // four separate 8-bit elements
packed_vec = 8'hA5;
unpacked_arr[2] = 8'hFF;
```

Packed arrays can be sliced, concatenated, and compared as numbers. Unpacked
arrays are for memories and queues. Do not mix the two in one declaration
until you can explain the difference out loud.

Slicing a packed vector uses the `[msb:lsb]` part select you already know,
plus the indexed part selects `+:` and `-:` which are safer in parameterized
code:

```systemverilog
logic [31:0] word;
logic [7:0]  byte2 = word[23:16];  // classic part select
logic [7:0]  byteN = word[i*8 +: 8]; // 8 bits starting at i*8, width from the select
```

`word[i*8 +: 8]` means "8 bits upward from bit i*8". I use `+:` everywhere a
generate loop or parameter touches the index; it removes a whole class of
off-by-one slice bugs.

## enum and typedef

Give your states and modes names. `typedef` plus `enum` makes an FSM readable
and lets the compiler catch typos.

```systemverilog
typedef enum logic [1:0] {IDLE, REQ, WAIT_ACK, DONE} state_t;
state_t state, next_state;
```

Always give the base type (`logic [1:0]` here). Without it, an enum defaults
to 32-bit `int`, which synthesizes into 32 flops for a 4-state FSM. Named
states also make waveforms readable: the viewer shows `WAIT_ACK` instead of
`2'b10`.

## struct packed: bundle related signals

```systemverilog
typedef struct packed {
  logic [7:0]  addr;
  logic [31:0] data;
  logic        valid;
} pkt_t;   // one 41-bit vector: assign, slice, and compare as a whole

pkt_t p;
p.addr  = 8'h10;   // field access, like software
p.data  = 32'hDEAD_BEEF;
p.valid = 1'b1;
```

A packed struct is a single vector underneath, so it flows through ports and
FIFOs as one unit. I use packed structs for bus transactions and FIFO
payloads; unpacked structs (without `packed`) are for testbench-side
bookkeeping that never becomes hardware.

## Parameters

Parameters make a module reusable. Use them for widths, depths, and anything
a parent module should configure.

```systemverilog
module counter #(
  parameter int WIDTH = 8
)(
  input  logic             clk,
  input  logic             rst_n,
  input  logic             en,
  output logic [WIDTH-1:0] count
);
  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n)
      count <= '0;
    else if (en)
      count <= count + 1'b1;
  end
endmodule
```

Override at instantiation with `#(.WIDTH(16))`. Use `parameter` for values set
at elaboration; use `localparam` for derived constants inside the module.

```systemverilog
localparam int AW = $clog2(DEPTH);  // derived, not overridable from outside
```

`$clog2` is the ceiling of log2: `$clog2(16)` is 4, `$clog2(17)` is 5. It is
how every parameterized address width in this repo is computed.

## Functions and tasks

A function computes a value and returns it; it cannot consume time. A task can
consume time (`@(posedge clk)`, `#10`) and is the workhorse of testbenches.

```systemverilog
// function: pure combinational helper, usable in RTL
function automatic logic [7:0] next_crc(input logic [7:0] crc, input logic bit_in);
  next_crc = {crc[6:0], bit_in} ^ (bit_in ? 8'h07 : 8'h00);
endfunction

// task: testbench driver that consumes time
task automatic drive_byte(input logic [7:0] b);
  repeat (8) begin
    sdi = b[7];
    b   = b << 1;
    @(posedge clk);
  end
endtask
```

`automatic` makes each call get fresh storage, which is what you want when
tasks run concurrently in a testbench. (Without it, variables are static and
shared between calls.) Functions belong in RTL for shared combinational math;
tasks belong in testbenches for stimulus.

## Ports and instantiation

Three ways to connect a module; I use the first two.

```systemverilog
counter #(.WIDTH(16)) u_cnt (
  .clk   (clk),    // named: explicit, order independent, self documenting
  .rst_n (rst_n),
  .en    (en),
  .count (count)
);
counter #(.WIDTH(16)) u_cnt2 (.*);  // implicit: connects by name, clk to clk
```

Named connections (`.clk(clk)`) are explicit and survive port reordering.
`.*` connects every port to a same-named signal in scope; it is compact and
safe as long as your signal names match the ports. Positional connections
(without names) exist but I never use them: one reordered port list and the
bug is silent.

## System tasks for debug

The handful I actually type:

| Task                          | What it does                                  |
| ----------------------------- | --------------------------------------------- |
| `$display("%0d %h %b", a, b, c)` | Print: decimal, hex, binary (`%t` time, `%s` string, `%m` hierarchy) |
| `$error("...")`               | Print an error; simulation continues          |
| `$warning("...")`             | Print a warning                               |
| `$fatal(1, "...")`            | Print and stop the run                        |
| `$finish`                     | End the simulation                            |

`%0d` (no padding) is the format I use 90 percent of the time; `%h` for
addresses and data. In messages, always print the values, not just the text:
`$error("count mismatch: got %0d, expected %0d", count, 20)` debugs itself.

## A simple testbench structure

```systemverilog
module tb_counter;
  localparam int WIDTH = 8;
  logic             clk = 0;
  logic             rst_n;
  logic             en;
  logic [WIDTH-1:0] count;
  counter #(.WIDTH(WIDTH)) dut (.*);
  // clock: 10 ns period
  always #5 clk = ~clk;
  initial begin
    rst_n = 0;
    en    = 0;
    repeat (3) @(posedge clk);
    rst_n = 1;
    // drive stimulus
    en = 1;
    repeat (20) @(posedge clk);
    en = 0;
    // check the result
    if (count !== 20)
      $error("expected 20, got %0d", count);
    else
      $display("PASS: count reached 20");
    $finish;
  end
endmodule
```

The pattern: instantiate the DUT with `.*` (implicit port connections by name),
generate the clock in an `always` block, and drive plus check in one `initial`
block. Real testbenches grow drivers, monitors, and scoreboards around this
skeleton, but the skeleton never changes.

Growing it: give each driver its own `initial` block or task so stimulus
streams run concurrently, sample DUT outputs on clock edges, and keep one
self-checking rule per behavior (`!==` so X fails loudly). The self-check is
the whole point; a testbench that only generates waveforms is a viewer, not a
test.

## Rules of thumb I use

* `logic` in RTL, `bit` in testbenches. `reg` and `wire` stay in legacy code.
* `<=` in `always_ff`, `=` in `always_comb`. Never mix on one variable.
* `always_comb`, never `always @(*)`. The function-call sensitivity trap is
  real.
* `unique case` on every mux and FSM next-state block. Missing or overlapping
  branches should be loud.
* `'0` for resets and defaults; sized literals everywhere else.
* `!==` in testbench checks so X fails instead of vanishing.
* Named port connections, or `.*` when the names line up. Never positional.
* Every testbench self-checks. If there is no `$error`, it is not a test.

## Interview angle

What interviewers actually probe on SystemVerilog basics, and the answer they
want:

* **"Blocking vs nonblocking?"** `=` updates immediately; `<=` updates at the
  end of the timestep. Use `<=` in `always_ff` so all flops sample
  simultaneously like hardware; `=` in `always_comb`. Never mix on one
  variable. Then say what goes wrong if you do (simulation race vs
  synthesized hardware).
* **"What infers a latch?"** An incompletely assigned variable in
  `always_comb`: some path leaves an output unassigned, so the tool holds the
  old value. Fix: defaults at the top of the block.
* **"`logic` vs `reg` vs `wire`?"** `logic` replaces both for single-driver
  code; `reg`/`wire` are legacy. Bonus: `logic` is 4-state, `bit` is 2-state.
* **"`==` vs `===`?"** `==` returns x when either side has x; `===` compares
  x/z literally. Use `===`/`!==` in testbench checks.
* **"How do you write a parameterized counter?"** Write the module from the
  Parameters section above from memory, with `localparam` for anything
  derived. They are checking parameter syntax and reset discipline, not the
  counter.
* **"`always_comb` vs `always @(*)`?"** `always_comb` includes signals read
  inside called functions in its sensitivity list; `always @(*)` misses them.
