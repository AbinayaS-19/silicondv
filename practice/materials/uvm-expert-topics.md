---
title: UVM Expert Topics
track: uvm
level: advanced
---

# UVM Expert Topics

Register modeling, virtual sequencing, layered sequences, and coverage driven
closure. These separate a working testbench from a complete environment. The
prerequisite is the build guide; nothing here makes sense without a running
agent, scoreboard, and sequences.

## The register model

The register model (RAL) mirrors the DUT's registers and stays in sync
through frontdoor or backdoor access. It is three things at once: a readable
specification of the register map, a predictor of what the registers should
hold, and an API your sequences call instead of hand-computing addresses.

```systemverilog
class my_reg_block extends uvm_reg_block;
  `uvm_object_utils(my_reg_block)
  rand my_ctrl_reg CTRL;
  rand my_stat_reg STAT;
  function void build();
    CTRL = my_ctrl_reg::type_id::create("CTRL");
    CTRL.configure(this); CTRL.build();
    STAT = my_stat_reg::type_id::create("STAT");
    STAT.configure(this); STAT.build();
    default_map = create_map("default_map", 'h0, 4, UVM_LITTLE_ENDIAN);
    default_map.add_reg(CTRL, 'h0, "RW");
    default_map.add_reg(STAT, 'h4, "RO");
    lock_model();  // freeze the structure; catches accidental post-build edits
  endfunction
endclass
```

Each register is built from fields (`uvm_reg_field`), each field configured
with its size, LSB position, access type (`RW`, `RO`, `W1C`, `RC`, and
friends), reset value, and volatility. Get the access types right: a `W1C`
(clear on write-one) status bit modeled as plain `RW` will predict wrong on
every interrupt test, and the failures will look like DUT bugs until you
learn to suspect the model first.

Register models also cover memories via `uvm_mem`, and backdoor access needs
an HDL path (`add_hdl_path`) so the model knows which RTL hierarchy to poke.
Set the HDL paths once, in the block's `build()`, and every backdoor
operation in every test just works.

## Adapter and predictor

The adapter translates register operations into bus transactions. The
predictor observes the bus and updates the mirrored values.

```systemverilog
class my_adapter extends uvm_reg_adapter;
  `uvm_object_utils(my_adapter)
  function uvm_sequence_item reg2bus(const ref uvm_reg_bus_op rw);
    my_txn t = my_txn::type_id::create("t");
    t.addr = rw.addr; t.data = rw.data;
    t.is_write = (rw.kind == UVM_WRITE);
    return t;
  endfunction
  function void bus2reg(uvm_sequence_item bus_item, ref uvm_reg_bus_op rw);
    my_txn t;
    assert($cast(t, bus_item));  // fail loudly if the wrong item type arrives
    rw.addr = t.addr; rw.data = t.data;
    rw.kind = t.is_write ? UVM_WRITE : UVM_READ;
    rw.status = UVM_IS_OK;
  endfunction
endclass
```

Wire it in the test:

```systemverilog
regmodel.default_map.set_sequencer(sqr, adapter);
regmodel.default_map.set_auto_predict(1);
```

`set_auto_predict(1)` tells the map to update its mirrored values from the
bus operations it issues itself. That covers everything your sequences do
through the model. It does not cover the DUT changing registers on its own:
a status bit the hardware sets, a counter that increments. For those you need
an explicit predictor, fed by the bus monitor's analysis port, so observed
bus traffic updates the mirror even when no sequence is running. Rule: auto
predict for registers only software touches; explicit predictor as soon as
hardware can change a register behind your back.

## Frontdoor vs backdoor

| | Frontdoor (`read`/`write`) | Backdoor (`peek`/`poke`) |
|---|---|---|
| Path | through the bus, via adapter and sequencer | direct HDL deposit/force, no bus traffic |
| Time | consumes simulation time | zero time |
| Checks | the bus path and the register | the register value only |
| Use for | normal operation, path coverage | fast init, debug, test setup |

```systemverilog
regmodel.CTRL.write(status, 32'hDEAD_BEEF);  // frontdoor: real bus cycles
regmodel.CTRL.poke(status, 32'hDEAD_BEEF);   // backdoor: instant, silent
regmodel.STAT.peek(status, rdata);           // backdoor read
```

Two more operations complete the set: `update()` writes only the registers
whose mirrored values differ from the DUT (a read-modify-write against the
mirror), and `mirror()` reads the DUT and compares against the mirror,
reporting mismatches. The classic bring-up flow is poke everything to reset
values, run the test, then mirror to check the hardware landed where the
model says it should.

Backdoor is a test accelerator, not a test replacement. A suite that only
pokes has never tested the bus path to the registers, which is exactly where
address-decode bugs live.

## Built-in register sequences

UVM ships sequences that exercise the model itself. Know what each one proves:

| Sequence | What it checks |
|---|---|
| `uvm_reg_hw_reset_seq` | every register holds its reset value after reset |
| `uvm_reg_bit_bash_seq` | each bit toggles independently (no stuck bits, no aliasing) |
| `uvm_reg_access_seq` | frontdoor read/write works through the real bus path |
| `uvm_mem_walk_seq` | memories read and write across their full range |

Run the reset and bit-bash sequences before you trust any register test.
Half of all "DUT register bugs" I have chased turned out to be model bugs:
wrong reset values in the field definitions, wrong access types, or an HDL
path pointing at last week's hierarchy.

## Virtual sequencers and sequences

A virtual sequencer holds handles to the real sequencers and coordinates
sequences across interfaces. It never has items of its own; it is a meeting
point.

```systemverilog
class my_vsequencer extends uvm_sequencer;
  `uvm_component_utils(my_vsequencer)
  uvm_sequencer #(my_txn)  bus_sqr;
  uvm_sequencer #(eth_txn) eth_sqr;
endclass
class my_vseq extends uvm_sequence;
  `uvm_object_utils(my_vseq)
  `uvm_declare_p_sequencer(my_vsequencer)  // gives you a typed p_sequencer handle
  task body();
    fork
      my_write_seq::type_id::create("wseq").start(p_sequencer.bus_sqr);
      eth_frame_seq::type_id::create("eseq").start(p_sequencer.eth_sqr);
    join
  endtask
endclass
```

The handles get assigned in the env's `connect_phase`
(`vseqr.bus_sqr = bus_agent.sqr;`). Nothing ever connects to a virtual
sequencer's `seq_item_export`, because nothing ever sends it items; sequences
started on it reach through `p_sequencer` to the real sequencers. If you find
yourself connecting a driver to a virtual sequencer, you have built a regular
sequencer by accident.

When two sequences must not interleave on one sequencer, the sequence calls
`grab(sqr)` for exclusive access and `ungrab(sqr)` to release it. Use it
sparingly: a grabbed sequencer serializes everything behind it, and a
forgotten `ungrab` deadlocks the testbench exactly the way a forgotten
`item_done` does.

## Layered sequences

Layering separates what to send from how to send it. The upper sequence
thinks in packets; a translator sequence breaks each packet into bus
transactions. The translator runs forever on the bus sequencer and pulls
packets from an upper sequencer through a pull port:

```systemverilog
// upper layer: what to send
class packet_seq extends uvm_sequence #(packet_txn);
  task body();
    repeat (5) begin
      packet_txn p = packet_txn::type_id::create("p");
      start_item(p);
      assert(p.randomize());
      finish_item(p);
    end
  endtask
endclass
// lower layer: break each packet into bus transactions
class packet_to_bus_seq extends uvm_sequence #(my_txn);
  uvm_seq_item_pull_port #(packet_txn) pkt_port;  // pulls from the upper layer
  task body();
    forever begin
      packet_txn p;
      pkt_port.get_next_item(p);   // blocks until the upper sequence provides one
      foreach (p.payload[i]) begin
        my_txn t = my_txn::type_id::create("t");
        start_item(t);             // driven through m_sequencer, the bus sequencer
        assert(t.randomize() with {
          addr == p.base_addr + i; data == p.payload[i]; is_write == 1;
        });
        finish_item(t);
      end
      pkt_port.item_done();
    end
  endtask
endclass
```

Connect the translator's pull port to the upper sequencer's export
(`translator.pkt_port.connect(pkt_sqr.seq_item_export)`), start the
translator on the bus sequencer, and start the packet sequence on the upper
sequencer. The layering pays off when the protocol changes: the packet-level
intent survives untouched while only the translator learns the new bus.

## Coverage driven closure

Coverage measures what the testbench actually exercised, and closure is the
discipline of driving the number to the goal with evidence, not hope.

```systemverilog
covergroup cg_bus_txn @(posedge vif.clk);
  cp_kind: coverpoint t.is_write {
    bins read  = {0};
    bins write = {1};
  }
  cp_addr: coverpoint t.addr {
    bins low  = {[0:15]};
    bins mid  = {[16:47]};
    bins high = {[48:63]};
  }
  cx_kind_addr: cross cp_kind, cp_addr;
endgroup
```

Sample in the monitor so coverage reflects observed behavior, not intended
stimulus. The clean structure is a coverage subscriber: a
`uvm_subscriber` connected to the monitor's analysis port whose `write()`
copies the transaction and calls `sample()`. The monitor stays a pure
observer, and coverage becomes one more subscriber that can be added or
removed without touching anything else.

Closure practices that separate professionals from checkbox tickers:

* Cross the interesting dimensions. Kind-by-address above catches the
  write-to-high-address case that single coverpoints miss.
* Add transition bins where order matters (idle to burst, read after write to
  the same address).
* Use `illegal_bins` for protocol violations you never want to see; an
  illegal bin hit is a bug report, not a coverage hole.
* Exclude unreachable bins explicitly with a comment saying why: an exclusion
  without a reason is a hole you chose not to look at. The waiver and its
  justification go into the coverage review, because the reviewer will ask.
* Track the trend, not just the number. Coverage that stalls at 92 percent
  for a week is telling you the remaining bins need directed tests, not more
  random seeds.

> **Rules of thumb I use:** I distrust the register model before I distrust
> the DUT, and I run the reset and bit-bash sequences to earn that trust. I
> put an explicit predictor on any register the hardware can change by
> itself. I sample coverage from observed transactions only. And I treat an
> uncovered cross bin as a missing test until someone proves it is an
> unreachable state with a comment I can read.

**What interviewers ask:** "Frontdoor or backdoor for register init in a
long test?" Backdoor poke for speed, then a frontdoor sanity access to prove
the path works; they want both halves of the answer. "Your mirror mismatches
on a status register the hardware updates. What is wrong?" Nothing is wrong
with the DUT; the model needs an explicit predictor or the field marked
volatile, because auto-predict only tracks what your sequences wrote.
"When do you stop writing tests?" When the coverage goals are met, the
waivers are justified in writing, and the scoreboard has been clean across
the regression. That is what closure means, and saying it plainly is the
whole interview.
