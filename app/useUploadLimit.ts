"use client";
import {useSyncExternalStore} from "react";
import {directTransferEnabled} from "../lib/direct-upload-client";
import {legacyUploadMaxBytes, normalUploadMaxBytes} from "../lib/upload-policy";

// The server snapshot keeps SSR/hydration consistent; the HTML transfer marker
// selects the browser limit before the hydrated uploader accepts files.
const subscribe = () => () => {};
const snapshot = () => normalUploadMaxBytes(directTransferEnabled());
const serverSnapshot = () => legacyUploadMaxBytes;
export function useUploadLimit() {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}
