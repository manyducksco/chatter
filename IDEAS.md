# Ideas

## React

```tsx
import { createClient } from "@manyducks.co/chatter";
import {
  ChatterClientProvider,
  useChatterClient,
  useProc,
} from "@manyducks.co/chatter-react";

const chatter = createClient({
  /* ... */
});

// Wrap your app
<ChatterClientProvider client={chatter}>
  {/* Draw the rest of the fucking owl */}
</ChatterClientProvider>;

// Use hooks
function MyComponent() {
  // Get the provided client directly.
  const chatter = useChatterClient();

  // Get a referentially stable callback for a procedure that uses the provided client
  // [the procedure, a boolean which is true while awaiting ack, the latest returned value (or undefined), the latest error]
  const [doThing, inProgress, result, error] = useProc(
    DO_THING /* , options? */
  );

  // Or maybe the callback and then an object with all of this so we can add stuff if necessary.
  const [doThing, { status, result, error }] = useProc(DO_THING);

  doThing(/* type safe input value */).then((output) => {
    // Returns a promise that takes the resulting value
  });

  // OR: Maybe make it one object.
  // Triggers re-render when any of these change, but `call` is always stable.
  const doThing = useProc(DO_THING);
  doThing.call(/* input */);
  doThing.status;
  doThing.result;
  doThing.error;
}
```
