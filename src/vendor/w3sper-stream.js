// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Copyright (c) DUSK NETWORK. All rights reserved.

// Backported verbatim from dusk-network/rusk-private, commit fd44d39e7,
// w3sper.js/src/protocol-driver/stream.js. The published 1.7.0-rc.0 reader
// drops read failures; remove this file/compat hook after upgrading the SDK.
function createBYOBReadableStream(stream) {
  const reader = stream.getReader();
  let leftover = new Uint8Array();
  let canceled = false;

  return new ReadableStream({
    type: "bytes",

    async pull(controller) {
      const request = controller.byobRequest;
      if (!request) return;

      const view = request.view;
      let offset = 0;

      while (offset < view.byteLength) {
        if (leftover.byteLength === 0) {
          const chunk = await reader.read();
          if (canceled) return;
          if (chunk.done) {
            if (offset === 0) {
              controller.close();
              request.respond(0);
            } else {
              request.respond(offset);
              controller.close();
              controller.byobRequest?.respond(0);
            }
            return;
          }
          leftover = chunk.value;
        }

        const length = Math.min(leftover.byteLength, view.byteLength - offset);
        view.set(leftover.subarray(0, length), offset);
        leftover = leftover.subarray(length);
        offset += length;
      }

      request.respond(offset);
    },

    cancel(reason) {
      canceled = true;
      leftover = new Uint8Array();
      return reader.cancel(reason);
    },
  });
}

export function getBYOBReader(stream) {
  return createBYOBReadableStream(stream).getReader({ mode: "byob" });
}
