export function streamFixture() {
  let writer,
    cancelled = false;
  const response = new Response(
    new ReadableStream({
      start(controller) {
        writer = controller;
      },
      cancel() {
        cancelled = true;
      },
    }),
    { headers: { "Content-Type": "text/event-stream; charset=utf-8" } }
  );
  const write = (text, byteSize = Infinity) => {
    const bytes = new TextEncoder().encode(text);
    for (let i = 0; i < bytes.length; i += byteSize)
      writer.enqueue(bytes.slice(i, i + byteSize));
  };
  const send = (value) =>
    write(
      `event: ${value.event_type}\r\ndata: ${JSON.stringify(value)}\r\n\r\n`
    );
  return {
    response,
    write,
    send,
    get cancelled() {
      return cancelled;
    },
    start: () =>
      send({
        event_type: "step.start",
        index: 1,
        step: { type: "model_output" },
      }),
    text: (text) =>
      send({
        event_type: "step.delta",
        index: 1,
        delta: { type: "text", text },
      }),
    complete: (status = "completed") =>
      send({ event_type: "interaction.completed", interaction: { status } }),
    close: () => writer.close(),
    fail: (error) => writer.error(error),
  };
}

export async function until(predicate) {
  // A fixed number of immediate turns can elapse before WebCrypto or I/O
  // finishes on a busy CI runner. Bound elapsed time while yielding to work.
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Expected streaming state did not arrive");
}
