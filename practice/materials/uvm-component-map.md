---
title: UVM Component Map
track: uvm
level: beginner
---

# UVM Component Map

Every UVM testbench is built from the same set of parts. This note maps each
component to its one job, the order they come alive in, and how they talk to
each other. Read this first and the build guide second; the map tells you
what everything is for, the guide shows you the code.

## The components, in plain words

* **Driver**: takes transactions from the sequencer and wiggles the DUT pins.
  It is the only component that touches the interface signals directly. It
  never decides what to send; it only translates a transaction into pin
  wiggles. One driver per interface, always inside an active agent.
* **Sequencer**: hands transactions to the driver, one at a time, in the order
  a sequence asks for. Think of it as the queue between stimulus intent and
  stimulus action. It runs the arbitration when several sequences want the
  driver at once. You almost never extend it; the base `uvm_sequencer` is
  enough until you reach virtual sequencers.
* **Monitor**: watches the DUT pins passively and rebuilds transactions from
  what it sees. It never drives anything. It is the testbench's eyes, and the
  scoreboard's facts come from here, not from the driver. If the monitor and
  the driver disagree about what happened on the pins, the monitor wins.
* **Agent**: the wrapper that holds a driver, a sequencer, and a monitor for
  one interface. An agent can be active (drives) or passive (only monitors).
  One agent per interface instance: a design with two UARTs gets two agents.
* **Scoreboard**: receives observed transactions from monitors and checks them
  against expected behavior. This is where the actual checking lives. It never
  touches pins and never generates stimulus; it judges.
* **Env**: instantiates and connects all agents and the scoreboard. One env per
  testbench, usually. If the agent is the wrapper for one interface, the env
  is the wrapper for the whole DUT.
* **Test**: builds the env, configures it, and starts the sequences. The test
  is the top of the hierarchy and the entry point you run. Different tests
  reuse the same env and run different sequences; that is the whole point of
  the separation.

### Active vs passive agent

| | Active agent | Passive agent |
|---|---|---|
| Contains | driver, sequencer, monitor | monitor only |
| Drives DUT pins | yes | no |
| Used for | interfaces the testbench stimulates | interfaces driven by something else (another DUT block, a CPU, a third-party VIP) |
| Configured by | `is_active = UVM_ACTIVE` (the default) | `is_active = UVM_PASSIVE` via the config db |

The passive agent is not a lesser agent. On a real project, half your agents
end up passive: the memory controller's agent watches while the CPU model
drives, and the scoreboard still needs to see every beat.

## Phase order

Phases are UVM's schedule. Each phase has a direction, a type, and one job.
The direction is the part beginners trip on, so here it is explicitly:

| Phase | Direction | Function or task | One line |
|---|---|---|---|
| `build_phase` | top down | function | construct children, pull config values |
| `connect_phase` | bottom up | function | wire TLM ports together |
| `end_of_elaboration_phase` | bottom up | function | print topology, check connections |
| `start_of_simulation_phase` | top down | function | set initial state, randomize knobs |
| `run_phase` | all at once | task | the only phase that consumes time; sequences run here |
| `extract_phase` | bottom up | function | pull data out of components (coverage, counts) |
| `check_phase` | bottom up | function | compare and report; scoreboards give their verdict |
| `report_phase` | bottom up | function | print the final summary |
| `final_phase` | top down | function | last cleanup |

Why top down for build: a parent must exist before it can create its
children, and a child reads its configuration from the parent, so the parent
builds first. Why bottom up for connect: a child's ports must exist before
the parent wires them, so the leaves connect first. `run_phase` is a task
because it is the only phase allowed to consume time; it can wait on clocks
and events. If your build code needs to wait for time, it is in the wrong
phase.

One phase is missing from most beginner notes and causes real confusion:
`run_phase` ends when all objections are dropped. If your simulation ends at
time zero with nothing happening, you forgot to raise an objection. Every
test's `run_phase` raises an objection, starts its sequences, and drops the
objection when they finish.

## TLM ports in plain words

TLM (Transaction Level Modeling) ports move transactions between components
without either side knowing the other's class type. The monitor does not know
or care that a scoreboard is listening; it just broadcasts.

| Port | Direction of data | Blocking | Plain words | Used by |
|---|---|---|---|---|
| `put` | sender pushes to receiver | yes | "Here, take this." | feeding a FIFO-like port |
| `get` | receiver pulls from sender | yes | "Give me the next one." | consumer controls the pace |
| `analysis port` | broadcaster to any number of listeners | no | "For anyone who cares, this just happened." | monitors to scoreboard and coverage |

The pattern you will write most: the monitor has an `uvm_analysis_port`, the
scoreboard has a `uvm_analysis_imp`, and `connect_phase` wires them together.
One monitor can feed any number of subscribers without changing the monitor.
The scoreboard can be replaced by a coverage collector tomorrow and the
monitor never notices; that decoupling is the entire reason TLM exists.

## A minimal connect example

```systemverilog
class my_env extends uvm_env;
  my_agent      agent;
  my_scoreboard sb;
  function void build_phase(uvm_phase phase);
    super.build_phase(phase);
    agent = my_agent::type_id::create("agent", this);
    sb    = my_scoreboard::type_id::create("sb", this);
  endfunction
  function void connect_phase(uvm_phase phase);
    super.connect_phase(phase);
    // monitor broadcasts; scoreboard listens
    agent.mon.ap.connect(sb.analysis_export);
  endfunction
endclass
```

Notice what `connect_phase` does not do: it creates nothing. Everything it
wires was built in `build_phase`. If you find yourself creating components in
`connect_phase`, stop; that is a build-phase job and the ordering guarantees
are working against you.

## How the virtual interface gets in

Beginners always ask: the driver needs the DUT signals, but components cannot
see the testbench top module. The answer is the config db, set once at the
top, read by whoever needs it:

```systemverilog
// in the top module, before run_test():
uvm_config_db#(virtual my_if)::set(null, "uvm_test_top.env.agent*", "vif", vif);

// in the driver's build_phase:
if (!uvm_config_db#(virtual my_if)::get(this, "", "vif", vif))
  `uvm_fatal("NOVIF", "virtual interface not set")
```

`set` stores a value under a hierarchical path; `get` searches upward from the
calling component until it finds a match. The `*` is a wildcard, so every
agent under the env picks up the same interface. The `uvm_fatal` on a failed
get is deliberate: a driver without its interface is not a driver, and you
want the simulation to die loudly at time zero instead of failing mysteriously
later.

## The factory, in one paragraph

The factory lets you swap a component or sequence type without editing the
testbench. In a test you write
`my_debug_driver::type_id::set_type_override(my_driver::get_type())` and
every `my_driver::type_id::create` in the hierarchy now builds your debug
driver instead. Same stimulus code, different driver, zero edits to the env.
You will use this constantly: error-injection drivers, alternate sequences
per test, and debug variants that print everything.

## How to read a UVM testbench you have never seen

1. Find the test class. It tells you which sequences run.
2. Read the sequences. They tell you what stimulus the DUT gets.
3. Find the scoreboard. It tells you what "correct" means.
4. Read the monitor. It tells you what is actually observed.
5. Read the agent's `build_phase`. The active/passive `if` tells you which
   interfaces the testbench drives and which it only watches.

Everything else is plumbing. Learn the map above and any UVM codebase becomes
navigable in an afternoon.

> **Rules of thumb I use:** I read a new testbench test-first, never
> file-alphabetical. I assume every analysis port has at least two
> subscribers until I check. And when a testbench behaves strangely, I print
> the topology (`uvm_top.print_topology()`) before I read a single line of
> driver code; half of all UVM bugs are structural, not behavioral.

**What interviewers ask:** "Why is `build_phase` top down but
`connect_phase` bottom up?" They want the reasoning above: parents create
children, children expose ports. Follow-up: "Why is the monitor passive and
the scoreboard separate from it?" Because observation and judgment are
different jobs; the monitor reports what happened, the scoreboard decides
whether it was correct, and keeping them apart means the checking can be
replaced without touching the pin-watching code. If you can say both of those
cleanly, you are past the beginner filter.
