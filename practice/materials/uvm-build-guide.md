---
title: UVM Build Guide
track: uvm
level: intermediate
---

# UVM Build Guide

A complete agent based testbench, built in order, with the reasoning for
every step. Follow it top to bottom the first time; after that, use it as a
reference for the step you are on. Every snippet compiles against standard
UVM once you fill in your interface and transaction details.

## Step 1: the transaction

The transaction is the unit of stimulus and the unit of observation. Keep it
small, keep it randomizable, and give it a way to print itself; you will read
its printout a thousand times.

```systemverilog
class my_txn extends uvm_sequence_item;
  `uvm_object_utils(my_txn)
  rand logic [7:0] addr;
  rand logic [31:0] data;
  rand bit         is_write;
  constraint c_addr { addr inside {[0:63]}; }
  function new(string name = "my_txn");
    super.new(name);
  endfunction
  // convert2string is the printout you will actually read in logs
  function string convert2string();
    return $sformatf("%s addr=%0h data=%0h", is_write ? "WR" : "RD", addr, data);
  endfunction
endclass
```

Three decisions are hiding here. First, the transaction carries what the
protocol needs and nothing else; the driver translates fields to pins, the
monitor translates pins back to fields, and both sides must agree on the
mapping. Second, `convert2string` is not cosmetic. When a mismatch prints at
3 AM, the difference between a useful log and a useless one is this function.
Third, constraints live on the transaction, not in the sequence. The sequence
says how many and roughly what kind; the transaction knows what legal looks
like.

A note on the field automation macros (the `` `uvm_field_* `` family): they
give you `compare()`, `copy()`, and printing for free, but they inflate
compile time and many teams ban them in favor of hand-written
`do_compare`/`do_copy`/`convert2string`. Either convention is fine; mixing
them in one codebase is not. Pick the team's rule and follow it.

## Step 2: the driver

```systemverilog
class my_driver extends uvm_driver #(my_txn);
  `uvm_component_utils(my_driver)
  virtual my_if vif;
  function void build_phase(uvm_phase phase);
    super.build_phase(phase);
    // the driver cannot see the top module, so the interface arrives by config db
    if (!uvm_config_db#(virtual my_if)::get(this, "", "vif", vif))
      `uvm_fatal("NOVIF", "virtual interface not set")
  endfunction
  task run_phase(uvm_phase phase);
    forever begin
      seq_item_port.get_next_item(req);  // blocks until the sequencer has an item
      drive(req);                        // wiggle the pins
      seq_item_port.item_done();          // unblocks finish_item in the sequence
    end
  endtask
  task drive(my_txn t);
    @(posedge vif.clk);
    vif.valid <= 1'b1;
    vif.addr  <= t.addr;
    vif.data  <= t.data;
    vif.wr    <= t.is_write;
    @(posedge vif.clk);
    vif.valid <= 1'b0;   // deassert after one beat; the protocol's beat is one cycle
  endtask
endclass
```

The driver loop is the heartbeat of stimulus: `get_next_item` blocks, `drive`
executes, `item_done` releases. If your simulation hangs, the first suspect is
always this handshake: a sequence that calls `start_item` without
`finish_item` leaves the driver blocked in `get_next_item` forever, and
nothing after it ever runs.

Drive pins with nonblocking assignments and sample them with blocking ones;
that is the standard discipline that keeps you out of race conditions with
the DUT's own flops. For serious pin timing, put the interface signals behind
a clocking block and drive through it; the clocking block's skew keeps your
drives and the monitor's samples on opposite sides of the clock edge.

## Step 3: the monitor

```systemverilog
class my_monitor extends uvm_monitor;
  `uvm_component_utils(my_monitor)
  uvm_analysis_port #(my_txn) ap;
  virtual my_if vif;
  function new(string name, uvm_component parent);
    super.new(name, parent);
    ap = new("ap", this);  // analysis ports are constructed, not factory-created
  endfunction
  task run_phase(uvm_phase phase);
    forever begin
      @(posedge vif.clk);
      if (vif.valid) begin
        my_txn t = my_txn::type_id::create("t");
        t.addr = vif.addr; t.data = vif.data; t.is_write = vif.wr;
        ap.write(t);  // broadcast: scoreboard, coverage, anyone listening
      end
    end
  endtask
endclass
```

The monitor reconstructs exactly what the driver sent, from the pins, with no
knowledge of the transaction that caused it. That independence is what makes
the check meaningful: if the driver has a bug in its pin mapping, the monitor
built from the pins will catch it, while a monitor that peeked at the
transaction would not. Sample on the same edge discipline as the DUT, and when
in doubt use a clocking block so your samples cannot race the DUT's updates.

## Step 4: the agent

```systemverilog
class my_agent extends uvm_agent;
  `uvm_component_utils(my_agent)
  my_driver               drv;
  uvm_sequencer #(my_txn) sqr;
  my_monitor              mon;
  function void build_phase(uvm_phase phase);
    super.build_phase(phase);
    mon = my_monitor::type_id::create("mon", this);
    if (get_is_active() == UVM_ACTIVE) begin
      drv = my_driver::type_id::create("drv", this);
      sqr = uvm_sequencer#(my_txn)::type_id::create("sqr", this);
    end
  endfunction
  function void connect_phase(uvm_phase phase);
    super.connect_phase(phase);
    // driver and sequencer talk through the built-in seq_item ports
    if (get_is_active() == UVM_ACTIVE)
      drv.seq_item_port.connect(sqr.seq_item_export);
  endfunction
endclass
```

The `get_is_active()` guard is the whole active/passive mechanism: in passive
mode the agent builds only its monitor. Set it from the test with
`uvm_config_db#(uvm_active_passive_enum)::set(this, "env.agent", "is_active",
UVM_PASSIVE)`. One agent class serves both roles, which means one file to
maintain instead of two.

Note the asymmetry: the monitor is built unconditionally, the driver and
sequencer only when active. The scoreboard always gets its observations,
whether this testbench drives the interface or merely watches someone else
drive it.

## Step 5: the scoreboard

The scoreboard's input side is an analysis implementation: the monitor calls
`write()`, the scoreboard reacts. The checking strategy depends on the DUT. An
in-order pipeline compares against a queue of expected transactions:

```systemverilog
class my_scoreboard extends uvm_scoreboard;
  `uvm_component_utils(my_scoreboard)
  uvm_analysis_imp #(my_txn, my_scoreboard) analysis_export;
  my_txn exp_q[$];          // expected transactions, in order
  int unsigned checked, mismatches;
  function new(string name, uvm_component parent);
    super.new(name, parent);
    analysis_export = new("analysis_export", this);
  endfunction
  // called by the test or a predictor whenever the next expected result is known
  function void expect(my_txn t);
    exp_q.push_back(t);
  endfunction
  // called by the monitor, once per observed beat
  function void write(my_txn t);
    checked++;
    if (exp_q.size() == 0) begin
      `uvm_error("UNEXPECTED", $sformatf("DUT produced %s with nothing expected", t.convert2string()))
      return;
    end
    my_txn e = exp_q.pop_front();
    if (!t.compare(e)) begin
      mismatches++;
      `uvm_error("MISMATCH", $sformatf("got %s, expected %s", t.convert2string(), e.convert2string()))
    end
  endfunction
  function void check_phase(uvm_phase phase);
    super.check_phase(phase);
    // leftovers are bugs too: expected transactions the DUT never produced
    if (exp_q.size() != 0)
      `uvm_error("DRAIN", $sformatf("%0d expected transactions never observed", exp_q.size()))
  endfunction
endclass
```

Three things to notice. First, `compare()` only works if the transaction's
fields are registered (field macros or a hand-written `do_compare`); an empty
`do_compare` compares nothing and every check silently passes. Second, the
`check_phase` drain check catches the bug class beginners miss: the DUT that
quietly drops a transaction looks perfect if you only compare what arrived.
Third, counts and verdicts live in `check_phase`/`report_phase`, not in
`write()`; `write()` records, the phases judge.

For out-of-order designs, replace the queue with an associative array keyed by
transaction ID and match on completion. Same skeleton, different lookup.

## Step 6: the env

The env builds the agents and the scoreboard and wires the analysis ports.
This is also where a second agent would be instantiated and where the virtual
sequencer (advanced note) will eventually live.

```systemverilog
class my_env extends uvm_env;
  `uvm_component_utils(my_env)
  my_agent      agent;
  my_scoreboard sb;
  function void build_phase(uvm_phase phase);
    super.build_phase(phase);
    agent = my_agent::type_id::create("agent", this);
    sb    = my_scoreboard::type_id::create("sb", this);
  endfunction
  function void connect_phase(uvm_phase phase);
    super.connect_phase(phase);
    agent.mon.ap.connect(sb.analysis_export);
  endfunction
endclass
```

## Step 7: sequences

```systemverilog
class my_write_seq extends uvm_sequence #(my_txn);
  `uvm_object_utils(my_write_seq)
  rand int unsigned n = 10;
  task body();
    repeat (n) begin
      my_txn t = my_txn::type_id::create("t");
      start_item(t);    // ask the sequencer/driver for the go-ahead
      assert(t.randomize() with { is_write == 1; });
      finish_item(t);   // hand it over; blocks until the driver calls item_done
    end
  endtask
endclass
```

`start_item`/`finish_item` is the explicit form; the `` `uvm_do `` macros wrap
the same calls. Many teams avoid the macros because they hide the
randomize-with block and the error handling, and what they hide, you cannot
debug. Either way, the sequence owns the what and the how-many, the
transaction owns the what-is-legal, and the driver owns the how.

A sequence does not raise objections. It cannot; it is an object, not a
component, and objections belong to phases. The test raises the objection,
starts the sequence, and drops the objection when the sequence returns.

## Step 8: the test

```systemverilog
class my_test extends uvm_test;
  `uvm_component_utils(my_test)
  my_env env;
  function void build_phase(uvm_phase phase);
    super.build_phase(phase);
    env = my_env::type_id::create("env", this);
    // example: run this agent passive in this test
    // uvm_config_db#(uvm_active_passive_enum)::set(this, "env.agent",
    //   "is_active", UVM_PASSIVE);
  endfunction
  task run_phase(uvm_phase phase);
    my_write_seq seq = my_write_seq::type_id::create("seq");
    phase.raise_objection(this);  // keep the simulation alive
    seq.start(env.agent.sqr);     // blocks until the sequence finishes
    phase.drop_objection(this);   // simulation may now end
  endtask
endclass
```

The test is deliberately thin: build the env, configure it, start sequences,
manage the objection. A test that contains checking logic or pin wiggles has
absorbed someone else's job. Launch it from the top module with
`run_test("my_test")`.

## Factory overrides and config db

Overrides swap a component or sequence without touching testbench code:

```systemverilog
// in the test: run the directed sequence instead of the base one
my_directed_seq::type_id::set_type_override(my_base_seq::get_type());
// swap the driver for one test only
set_inst_override_by_type("env.agent.drv",
  my_driver::get_type(), my_debug_driver::get_type());
```

`set_type_override` replaces the type everywhere it is created;
`set_inst_override_by_type` replaces it only under the given hierarchical
path. The debug-driver pattern is the daily workhorse: one test gets a driver
that prints every beat, the rest of the suite is untouched.

```systemverilog
// from the top module or test: hand the interface to every agent's driver/monitor
uvm_config_db#(virtual my_if)::set(null, "uvm_test_top.env.agent*", "vif", vif);
// from a test: flip one agent to passive
uvm_config_db#(uvm_active_passive_enum)::set(this, "env.agent",
  "is_active", UVM_PASSIVE);
// from a test: pick the default sequence without writing a custom run_phase
uvm_config_db#(uvm_object_wrapper)::set(this, "env.agent.sqr.run_phase",
  "default_sequence", my_write_seq::type_id::get());
```

Config db rules that save debugging time: `set` before the component's
`build_phase` runs, or the `get` finds nothing; a more specific path beats a
broader one; and the type parameter must match exactly between set and get,
including the `virtual` on interfaces.

> **Rules of thumb I use:** I write the scoreboard's `check_phase` drain
> check before I write a single `write()` comparison, because dropped beats
> are the bug I am most afraid of missing. I never let a sequence raise an
> objection; the test owns simulation lifetime. And I treat every
> `` `uvm_fatal("NOVIF") `` as a friend: a testbench that dies at time zero
> with a clear message beats one that limps to time 1000 and fails
> mysteriously.

**What interviewers ask:** "Your simulation ends at time zero, nothing
happens. What do you check?" The objection: nothing raised one, so
`run_phase` ended immediately. Next: "Driver hangs in `get_next_item`,
what happened?" A sequence called `start_item` and never reached
`finish_item`, or no sequence started at all. Next: "Why does the monitor
rebuild transactions from pins instead of reusing the driver's
transaction?" Because an independent observation is the only one that can
catch a driver bug. Those three answers cover most intermediate UVM
interviews.
