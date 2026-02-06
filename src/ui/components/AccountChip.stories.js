import { accountChipEl } from "./AccountChip.js";

export default {
  title: "Components/AccountChip",
};

export const Disconnected = () =>
  accountChipEl("acct0", {
    onCopy: (msg) => console.log(msg),
    connected: false,
    host: "dapp.example",
  });

export const Connected = () =>
  accountChipEl("acct0", {
    onCopy: (msg) => console.log(msg),
    connected: true,
    host: "dapp.example",
  });

