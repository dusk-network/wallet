# Dusk Wallet Privacy Policy

Dusk Wallet is a non-custodial browser extension for the Dusk network.

## Local wallet data

Recovery phrases and private keys are encrypted locally on your device. Dusk Network does not collect, store, or custody your recovery phrase or private keys.

The extension stores local wallet data needed to operate the wallet, including encrypted vault data, wallet settings, approved dApp origins, watched assets, address book entries, local transaction metadata, your profiles' transaction history, and the latest checks of .dusk names.

## Network data

To provide wallet functionality, Dusk Wallet communicates with configured Dusk node, prover, and archiver endpoints. These requests may include wallet addresses, balance queries, shielded note sync data, transaction data, transaction status queries, and transaction submission data.

Users may configure their own endpoints. Network operators may be able to observe requests sent to their endpoints.

Looking up a .dusk name sends the name to your configured node. Showing your profiles' .dusk names sends their public accounts to it, as does showing the name of a public account a site asks you to send to.

Activity asks your configured archiver for each profile's public transaction history, which sends it the profile's public account, and asks your node for the .dusk names of the accounts in that history, several at a time through the Multicall for Dusk contract. Once for each profile that has shielded notes, it asks the archiver for the blocks those notes are in, each mixed with four other blocks that hold shielded notes, which makes the profile's blocks harder, though not impossible, to pick out.

## dApp connections

Dusk Wallet only shares wallet profile information with a dApp after you approve a connection request.

A connected dApp also gets the profile's .dusk name, once the wallet has checked that the name points to the profile's public account.

Shielded addresses require separate explicit approval before they are shared with a dApp.

Transaction and signing requests show approval prompts before the wallet signs or submits anything.

## Remote code

Dusk Wallet does not load or execute remote code. Executable JavaScript, WASM, and extension assets are packaged with the extension.

## Data sale and unrelated use

Dusk Wallet does not sell extension user data.

Dusk Wallet does not use extension user data for purposes unrelated to wallet functionality.

Dusk Wallet does not use extension user data to determine creditworthiness or for lending purposes.

## Contact

For privacy questions or wallet support, contact Dusk Network through the official contact form or Discord:

- Contact form: https://dusk.network/contact/
- Discord: https://discord.gg/dusk-official
