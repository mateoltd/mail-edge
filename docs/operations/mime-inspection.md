# Bounded MIME inspection

Structural and semantic MIME inspectors own the input iterator for the duration of a run. Abort
destroys the Node readable and mailsplit parser immediately, races a blocked `next()` call, and
invokes `iterator.return()` under a 100 ms cleanup ceiling. This prevents a source that ignores
cancellation from holding the inspection promise open.

Both inspectors enforce byte, line, header, part, depth, attachment, and decoded-content ceilings.
They also accept an injected CPU clock and instrumentation sink. `maxProcessingCpuMilliseconds` is
checked at streaming and parser checkpoints; the sink receives content-free phase, outcome,
byte-count, and CPU-duration metrics. Synchronous third-party parser calls are measured immediately
after return, so profiling these metrics is the prerequisite for deciding whether a deployment also
needs worker isolation. Worker isolation is not a default requirement without that evidence.
