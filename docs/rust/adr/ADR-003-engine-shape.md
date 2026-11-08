# ADR-003: Synchronous core, thin async shell, synchronous ports
**Context.** The engine must be deterministic to test, own its tasks, and never create a runtime per FFI call.
**Options.** (a) async everywhere with async port traits; (b) actors with message passing; (c) a synchronous state machine driven by inputs, wrapped by one runtime thread.
**Decision.** (c). `Core` is a plain struct whose methods are inputs and whose effects go through port calls that return promptly. `EngineHandle` owns one thread with a current-thread Tokio runtime, a bounded command queue and a retry timer. Adapters push link changes and frames in as inputs.
**Consequences.** Tests run without threads or sleeps (fake clock, in-memory ports). No lock around the engine. A slow port call would stall the engine, so ports must not block on the network. Event readers get bounded queues and a `Lagged` marker instead of back-pressure on the engine.
**Revisit if** a port genuinely needs to await (then make that one port async), or if one thread becomes a throughput limit with many peers.
