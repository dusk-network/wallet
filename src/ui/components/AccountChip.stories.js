import { accountChipEl } from "./AccountChip.js";

export default {
  title: "Components/AccountChip",
};

export const Disconnected = () =>
  accountChipEl("acct0", {
    onClick: () => console.log("open profiles"),
    connected: false,
    host: "dapp.example",
  });

export const Connected = () =>
  accountChipEl("acct0", {
    onClick: () => console.log("open profiles"),
    connected: true,
    host: "dapp.example",
  });
