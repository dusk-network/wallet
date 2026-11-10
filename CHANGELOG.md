# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Added Lock when I leave the app to the Android app's Settings, off at first.
- Gave the Android app Dusk's icon, in the launcher and on its splash.
- Brought back the app for Android and desktop (Tauri), in `apps/tauri`.
- Opened `dusk:` payment links in the Android app's Send, filled in.
- Shared an address or a request from the Android app through the phone's share sheet.
- Declared Firefox for Android, from version 142, so the add-on can be listed for phones.
- Added a record per site to Settings' Connected sites: when it was last used, what it asked for and how you answered, also once it's disconnected, with Forget.
- Added connections that end after 1, 7 or 30 days, for each site and for new sites.
- Added an optional password on any send above an amount you choose, in Settings, off by default: the wallet's own sends and a site's, checked against the vault.
- Showed a Sozu stake's position on Liquid staking: put in, taken out, worth now, deposit fees and rewards so far.
- Said what an amount brings in a year with Sozu as it's typed, and one line of what the rate is made of under it.
- Showed one ledger in a bridge transfer's details, to the last lux: sent, bridge fee, network fee and what arrives.
- Showed what a migration to Dusk paid on BNB Smart Chain or Ethereum in its payout's details, its approval too, to the wei, and put those fees in the export.
- Offered the extension's Send, filled in, on the web wallet's Send page opened from a request link.
- Added `dusk_openPaymentLink`, for the web wallet's own button to open a request link in the extension's Send.
- Warned on Review when a payment repeats one you made moments ago, or one with the same memo.
- Listed the requests made in Receive, each Waiting, Paid, Check or Paid twice, with its payments to open.
- Added Copy link to each request in Receive.
- Added Copy app link beside Share in the Android app's Receive, for the dusk: link that opens the app's Send.
- Showed staking rewards by calendar year on Staking: native rewards claimed, and what Sozu's unstakes earned.
- Added a search to Activity: by name, address, memo, transaction ID or amount.
- Gave the export's values in the currency of the browser's region where CoinGecko prices DUSK in it, as Singapore dollars, and in US dollars elsewhere.
- Made a release's zips rebuild byte for byte from its tag, with their SHA-256 in the release notes.

### Changed

- Saved Activity's export and a QR code to the phone's Downloads in the Android app, saying so.
- Opened the explorer and other sites in the phone's browser from the app, never in the wallet's window.
- Kept the Android app's screens out of screenshots and the app switcher.
- Said things for a phone in the Android app: no browser, connected sites, Caps Lock or right-click.
- Put the Android app in the background from its first screen with Back, rather than closing it.
- Opened a site's approval in a tab where the browser has no windows, as in Firefox for Android.
- Made the popup's Connect ask in the site's approval, and kept it off Send, Shield, Stake, every Review and Sent.
- Opened the network choice from the pill before a wallet is set up and while it's locked, as Settings does.
- Asked before Reset in the wallet's own dialog rather than the browser's.
- Let Send's To field wrap onto more lines, so the whole address shows.
- Told a site nothing of the wallet's network or version before it connects; the network comes with the connection.
- Counted what's staked, natively and with Sozu, in Home's total balance, read with the public balance, and showed it beside the rest.
- Gave Sozu's rate as stDUSK grew over the last 30 days, on Liquid staking and Staking, where the chain says it.
- Gave native staking's rate as the chain paid stakers over the last 30 days, and said over what days each staking rate was measured.
- Made Activity's Export a file for accountants and tax tools, in Koinly's universal CSV: a quarter or any dates, your profile's name on it, transfers between your profiles marked, stDUSK and fees for staking, and values in your currency and Excel's accents when asked.
- Showed an amount and its fee to the last lux in a transaction's details, on Sent and on every Review; rows and balance lines stay short.
- Made a request link the https form, which opens the web wallet's Send filled in; Send also reads it pasted or scanned.

### Fixed

- Looked each send left waiting through a lost signal up again once the signal returns, and said Completed with its fee, or Not sent.
- Said Not sent for a send that couldn't reach the network.
- Said Offline on a Review and on a site's approval, holding Confirm and Approve until the connection is back.
- Said Offline in the Android app as soon as the phone loses its signal.
- Noted a site's approved send that didn't go out as Approved, not sent, in Connected sites.
- Said Offline or Can't reach beside the network's dot, and checked the network again once it answers.
- Ended "Checking network…" on setup once the network was checked.
- Asked before Back clears the recovery phrase and password typed on Import.
- Rejected a site's approval with the phone's first Back in Firefox for Android, no tap first, and went back to the site's tab.
- Kept a site's approval waiting while you switch tabs in Firefox for Android.
- Opened a request link or a notice in the wallet's tab already open, rather than another.
- Closed an approval's tab that said its request ended once you leave it, and said a connection request ended without pointing to Activity.
- Titled the tab Firefox for Android shows for the wallet's engine "Keep open", saying closing it locks the wallet.
- Showed no system notices on a phone, so Android never asks for them over a payment.
- Stopped Firefox offering a strong password of its own for a new wallet password.
- Typed recovery words on a phone in boxes the keyboard learns nothing from, with Show words.
- Named a bridge's call in Connected sites with its approval's own words.
- Made Reveal, Hide and Copy on the recovery phrase a finger's size.
- Scrolled the field being typed in, and its button, above the keyboard in Firefox for Android's tab.
- Put a contact's name over the address in Send's To, the address at the field's whole width.
- Went back from Settings, and from Add wallet, to the screen it was opened from.
- Showed only the message and Choose image in Scan QR without a camera.
- Said in the app what the password on big sends covers without sites, and why the wallet stopped waiting for a send in plain words.
- Said No connection while a send waits offline, rather than how long a block takes.
- Gave the keyboard's room back as the phone turns, and put the page back where it was.
- Named a saved QR by what it asks and when it was made, wrote its amount, memo and name under the code, and said the name Android saved it as.
- Named a saved export by when it was made, and said the name Android saved it as.
- Read the balance again as the Android app comes back to the front.
- Kept a setup form's words and passwords through the wallet drawing again.
- Kept a site's approval through Firefox for Android stopping the wallet in the background, so Approve still works; if it can't, the approval and the site say the request ended.
- Rejected an approval with the phone's Back.
- Said a misspelled recovery word by Import wallet too.
- Fixed import and unlock that never finished in the app.
- Fixed Download QR in the app, which said "Failed to render QR".
- Showed the network's real status in the app.
- Started the Android app below the phone's status bar, its icons light on the dark page.
- Said a lost connection in words on a send's steps.
- Made a phone's Back button go one screen back inside the wallet, keeping what's typed, rather than closing it.
- Kept the field being typed in, and its button, above a phone's keyboard.
- Looked a payment up again as the wallet comes back after being left mid-send, so it no longer waits for a block that came.
- Kept Home's balance labels from running into their amounts on a phone.
- Filled the phone's width with the popup in Firefox for Android.
- Stopped Backspace in an empty recovery-word box from deleting the words before it.
- Started a payment request over when the profile, wallet or network changes.
- Made the contact search find recent recipients too.
- Opened Liquid staking on Stake after an unstake.
- Told a site the wallet couldn't show its request, rather than that it was cancelled, and said so in Connected sites.
- Refused a request link that says a field twice or has a user part before its host, and one for another network the moment it's put in, saying only why.
- Said when a number in a message to sign, a sign-in or a memo mixes digits of different scripts or reads right to left.
- Said when a number in a message to sign, a sign-in or a memo is in digits that look like other digits, as Bengali's ৪, a 4 that looks like an 8.
- Refused a contact's or a profile's name with hidden characters, and showed a contact saved with them by their codes, saying so.
- Refused a dusk: link for another network by the network its query names, and a link whose memo has a line break.
- Emptied the whole form when a link is refused, and said why for each refused link.
- Said what came in on every Paid request, one of any amount too.
- Listed each payment of a request paid twice with what it brought and when, and Send back on the extra one.
- Found what's searched typed without its accents, in Activity and Contacts, and an amount typed with either decimal mark.
- Showed each Activity row's memo under its name.
- Said what a stake or an unstake with Sozu got or gave back in stDUSK, and the rate, on Completed as soon as it went through, and in its details.
- Said at once when the connection drops, kept the balance read last as maybe out of date, and read it again by itself once back.
- Kept the extension's own files from sites: no page can load them, but for the provider script Firefox puts in it.
- Told a site that never connected, or whose connection ended, nothing as the wallet switches network.
- Opened one Send for each press when the web wallet hands a request over, however often it asks.
- Took a request from a page on this machine only while the wallet's node is there too, and only one that says its network.
- Kept Home's breakdown of Public, Shielded and Staked from starting a line with its dot when it wraps.
- Caught contact names that look alike in any script, by Unicode's table, and marked them in Contacts and Send's suggestions beside their addresses.
- Refused a contact named like one of your profiles, and called your other profiles "Your profile" on Review.
- Repeated on Review that a send goes to your own account, and said what to try after a wrong password.
- Took a paid request link off the page's address, so a reload doesn't bring the payment back ready to send.
- Said on Send when you already paid the same payment, and named Review's button Send … again.
- Showed Sent back, with when, rather than Send back once a request's extra payment went back.
- Dropped "so far" from what a Sozu stake got once it's final.
- Gave a request's payments to the second, so two in one minute differ.
- Drew addresses and amounts without the font's contextual alternates, so an x between digits stays an x.
- Put Review stake right under the amount, so a phone's keyboard doesn't cover it.
- Asked which amount is meant, and which spaces to leave out of one like 1 234,5, in the web wallet's words.
- Read a plain dusk:<address>?amount=&memo= link, and said a link's network can't be read rather than naming one twice.
- Refused a profile's name that is, or looks like, another profile's or a contact's.
- Showed what came in on a request of any amount in its badge, in plain colour, rather than a green Paid.
- Said a number's look-alike digits in the web wallet's words.
- Kept another wallet's shielded history out of Activity and Export when the wallet changes during a read; an Export it changes under saves nothing and says so.
- Said under a .dusk name when a node the wallet doesn't know checked it, and kept that node's answers from the network's own node's.
- Said plainly on Home when the balance can't be read, instead of showing what the node said.
- Warned on a contact name already in use, and on your own address.
- Read an amount as the browser's language groups it: 1 000 in French, 1'000 in Swiss German.
- Named Mainnet, Testnet and Devnet only at their exact addresses: any other node is Custom with its host, whatever it says of itself.
- Fixed the chain ID on everything signed, and refused to sign, saying why, while the node answers another.
- Showed the node's host in large type in a site's network-switch window, with what that node can see and show, and never Switch to Mainnet for another address.
- Kept the same recovery words through Back while a wallet is being created.
- Switched network as soon as it's chosen in Settings, and said a custom node isn't saved until Save.
- Went back to Mainnet on Reset, and removed the profile names, tokens, checked names and custom nodes kept with it.
- Neutralized and flagged characters that change how text reads, in messages to sign, sign-ins and memos: approvals, Review, Sent and a transaction's details.
- Checked the balance covers the amount and the fee in site approvals, forms and Reviews, saying how much is missing, with Approve and Confirm off.
- Said when a site chose the fee, compared with the network's price, with a way back to that price when it's high.
- Said why a node refused a transaction in the wallet's own words, never as its raw reply.
- Named your other profiles in Activity, a transaction's details, toasts and Send, and stopped offering to save them as contacts.
- Gave Request payment the checks Send has: an amount over 0, a memo of 512 bytes at most, and Copied goes when the request changes.
- Said when an amount could be two amounts, or has too many decimals, on every amount field.
- Kept Review off on Send and Shield while the amount typed won't do.
- Kept Confirm, and what stops it, in view on every Review.
- Wrote percentages, token amounts and examples in the browser's number format, and a time zone's name the same on every screen.
- Renamed Manage profiles in the profile menu to Profile names.
- Listed Devnet as Experimental, and the network menu's other hints, in Settings' network list.
- Refused a new password that's the same as the current one.
- Cleared a Sozu stake's "on its way" note once the stake is done, also after a browser restart.
- Refused a request link for another network in Send: it fills in nothing, says why, and can't be confirmed.
- Said "Filled in from the link. Check it before you send." under the recipient, in place of a toast over Review.
- Kept numbers beside right-to-left words in the order a site wrote them, in messages to sign, sign-ins, memos and a site's own words.
- Neutralized and flagged characters that change how text reads in a contract call's function: approvals, Activity and a transaction's details.
- Said when a message to sign or a sign-in's statement goes on below its box.
- Named the chain a site's transaction signs for in its Details, apart from the chain ID sites see.
- Kept a site's refusals in its record, however often it asks and cancels.
- Warned on a contact name that looks like another one's in other letters.
- Marked the network Custom while its prover or archiver isn't the network's own, saying whose, and refused plain http to another computer in Settings.
- Said what Max keeps of a stake with Sozu, and on its Review that the deposit fee doesn't come back.
- Showed what an unstake from Sozu brings back on Home and in Activity from the moment it's sent.
- Showed the whole address on Receive, with a Copy address button that says Copied.
- Showed the recovery words at 18 px, with I wrote it down kept in view.
- Stayed on Mainnet, Testnet or Devnet through a restore after a forgotten password; a custom node goes, as on Reset.
- Wrote the stDUSK a Sozu unstake burned in the accounting export, as the trade back.

## [0.4.0] - 2026-11-04

### Added

- Added more than one recovery phrase, all unlocked with one password: Add wallet creates or imports another, says which wallet it becomes, and refuses one that's already here.
- Grouped the profile switcher by wallet, as Wallet 1 and Wallet 2, and switched to another wallet's profile without the password.
- Named the open wallet under the profile in the header, and beside it on Reviews and site requests, when there's more than one wallet.
- Added Wallets to Settings, to rename a wallet or remove it with the password.
- Added Change password to Settings, for every wallet here.
- Named the wallet of each site in Settings' Connected sites when there's more than one wallet.
- Added a Bridge filter to Activity, which now holds bridge transfers instead of Sent and Received.
- Said when a deposit to DuskEVM arrived, and added View in DuskEVM explorer to its details.
- Said Arrived on a deposit to DuskEVM once it's there, and linked its transaction on DuskEVM's explorer.
- Offered alice.dusk for a recipient typed as alice or alice.dusk.
- Linked Dusk's Terms of use and Privacy policy in Settings, under About.
- Said about what each way of staking pays a year, beside the choice: native staking across the network lately, and Sozu after its fee.
- Warned about a recipient listed as compromised or a scam, on Send and in a site's request, and sent it nothing.
- Added Activity to the full view's sidebar.
- Added Forgot your password? to the unlock screen: a restore from the recovery phrase that keeps the same wallet's contacts.
- Showed Sozu's fees on Liquid staking as its contract has them: its share of rewards, the deposit fee and no fee to unstake.
- Showed Sozu's deposit fee on each stake as it's typed and on Review, and took it off what the stake gets.
- Turned staking with Sozu off while Sozu has paused deposits or they can't be checked, and warned while its pool is synchronizing.
- Read Sozu's terms again before sending a stake, and showed them for another Confirm when they changed.
- Showed the 1 DUSK bridge fee and what arrives on BNB Smart Chain when paying the bridge's account, in its approval and on Send's Review.
- Said that the testnet bridge to Sepolia isn't running right now, in its approval and on Send's Review.
- Added Export to Activity: the rows listed as a CSV file with the web wallet's columns, your contact names only when asked.
- Showed a site's payment to the bridge's account as a bridge to BNB Smart Chain, or Ethereum (Sepolia) on Testnet, with the memo as the recipient there, and a warning when the memo isn't an address there.
- Said at the top of a test network, in the popup, the full view and site approvals, that test DUSK has no value.
- Read the DuskEVM bridge's deposit, prove and claim calls on Testnet in their approvals: amount and recipient, marked as a known bridge call.
- Accepted a gas limit without a price from sites, at the node's gas price.
- Added a Sent screen after Confirm that follows the transaction: Sending, Sent to the network, then Completed or Failed with the reason and the fee charged, with its ID, Copy and the Dusk explorer link.
- Showed the profile's full public history in Activity, including received transfers.
- Showed the profile's shielded history in Activity.
- Named Activity's counterparties by their verified `.dusk` names.
- Added day groups and All, Sent, Received and Staking filters to Activity's full list.
- Labelled DuskEVM bridge transfers in Activity.
- Suggested a close `.dusk` name from contacts and past transfers when a typed one isn't registered.
- Showed a pasted public account's verified `.dusk` name on Send.
- Named the profile that pays on Send's Review, and a contact by both its label and its verified name.
- Said on a public send's Review what everyone can see: the amount, the memo and your name.
- Saved contacts from `.dusk` names, keeping the name and checking it again before it's an hour old.
- Added a Disconnect for each connected site, and custom gas under Settings' Advanced.
- Showed a new wallet how to get its first DUSK, with Receive, instead of empty Tokens and NFTs.
- Added a spinner on the network pill while the wallet switches network.
- Added an eye button beside the total balance that hides every balance behind ••••; the choice is remembered. ([#130])
- Gave connected sites the profile's verified `.dusk` name, as `name`. ([#127])
- Showed the profile's verified `.dusk` name in the approval pop-ups. ([#127])
- Named the recipient of a site's transfer under its address: your profile, a saved contact, or its verified `.dusk` name. ([#127])
- Added sending to `.dusk` names on Mainnet and Testnet, to their public account or shielded address. ([#125])
- Showed each profile's verified `.dusk` name in the header, the profile switcher and Receive. ([#125])
- Added a warning when sending to your own account or address. ([#125])
- Showed on Review whether the transfer is visible on chain. ([#125])
- Added a full escaped typed-data request view alongside the bounded approval preview. ([#113])
- Displayed the installed extension version in Settings. ([#80])
- Added `dusk_signTypedData`, letting dApps request a signature over structured data the wallet renders — domain, primary type, and bounded, potentially truncated message previews with declared field types — instead of an opaque digest. The wallet injects the requesting origin into the digest and echoes it in the result. ([#22])

### Changed

- Followed DUSK bridged to BNB Smart Chain or Ethereum to its end: On its way, then Arrived, with the bridge fee, what was received and its transaction there
- Listed DUSK bridged out under Sent and in under Received, as well as under Bridge
- Wrote and read amounts in the browser's language, so 1,001 doesn't read as about one on a Dutch browser
- Showed a migration's payout with its transaction on the other chain, not as a memo
- Link to the explorer at its own domain
- Opened and closed sections the same way, said Copied on the copy button instead of a toast, faded messages in place, and had Confirm and Approve ignore a click for half a second as they appear.
- Showed a turning ring beside the words while staking, Sozu, tokens, contacts or activity load.
- Opened the popup faster.
- Read a balance, Sozu's status or a token's balance once for a few seconds, checked the network's endpoints at most every 5 minutes unless one fails, and checked the .dusk lens once a session.
- Found where a deposit to DuskEVM arrived in fewer requests.
- Kept site connections, sends and DuskEVM arrivals per wallet: a site connected to one wallet sees nothing of another.
- Filled every word box from a whole recovery phrase pasted into any of them, with 24 boxes for 24 words.
- Said what's wrong with a recovery phrase after a paste or on leaving its boxes: a word that isn't one, a missing word, the count or the checksum.
- Gave the recovery phrase's word boxes a visible edge.
- Said on Forgot your password? and Reset wallet that they remove every recovery phrase here.
- Said Lock in Settings, and that auto-lock locks every wallet, when there's more than one wallet.
- Called a profile's label its name in Settings.
- Named a send's recipient in Activity by its verified `.dusk` name before the name typed when sending.
- Showed a failed shield's details as a shield's, from the public balance to the shielded one.
- Dropped Submitted and Shielded reservation from a send's Technical details once the chain's history has all of it.
- Named DUSK bridged to and from BNB Smart Chain and Ethereum in Activity by their routes, To BNB Smart Chain and From Ethereum, under Bridge, with the bridge's account it went through.
- Named a `.dusk` name's reservation in Activity by the name its registration reveals, else Name reservation (step 1 of 2).
- Said on Send that a pasted 0x address is an EVM address, not a Dusk account, and kept Review off.
- Called a failed shield Shield attempt (failed) in Activity, and one that went through Shield, not Call convert.
- Named Dusk Domains' contracts in Technical details, and every named contract in approvals, as the explorer does.
- Said under Reset what it removes, and that your funds stay on Dusk.
- Hid Sozu's deposit fee in DUSK while balances are hidden, on the stake form and its Review.
- Worked out Sozu's yearly estimate from native staking's figure as shown, as the web wallet does, and added Not promised.
- Moved Sozu's contract from the stake form to its Review, under Custom fee.
- Dropped the note that a failed call is charged its whole gas limit.
- Said what's visible to everyone only on sends, not on staking Reviews or the bridge, allowance and other contract approvals.
- Shortened EVM addresses and transactions to 0x and four characters at each end, addresses with their checksum, and Dusk IDs to six at each end in approvals and notifications too.
- Renamed Exact fee to Fee paid under Technical details, and Function to Method in approvals.
- Showed stDUSK estimates to 4 decimals.
- Said only that native staking needs your own Dusk node, with Run a node to Dusk's docs on running one.
- Wrote dates and times as every Dusk app does: in English, on the language's clock, as "Mon 26 Oct 2026, 2:32 PM CET", in the export too.
- Wrote Dusk contract IDs without 0x, and an ellipsis as one character.
- Wrote fees under 0.01 DUSK to 2 significant digits, a maximum still rounded up.
- Said "no fee" on a failed row that paid none, not "fee 0 DUSK paid".
- Found the network by the chain ID its node gives, not its address: a custom node gets its network's names, Sozu, bridge, explorer and history, and one that hasn't said is Custom, not Mainnet.
- Named the contracts and accounts the network's file names, in Activity and Technical details.
- Named the bridge's chains as the network's routes do: BNB Smart Chain, and Sepolia on Testnet.
- Led a withdrawal's prove and claim approvals with what they cost, then the withdrawal.
- Named the connected site in the popup as its approval did: with its port, and http:// for a local one.
- Marked the popup's top row as its header and its page as main, for screen readers.
- Showed a profile's `.dusk` name beside its short account in the profile switcher.
- Said that native staking's Max keeps both fees: this stake's and the one to unstake later.
- Named a `.dusk` name's registration in Activity by the name it registered.
- Moved a contract call's contract from under its title to Technical details, with Copy.
- Hid a failed row's fee in Activity while balances are hidden.
- Said that unstaking from Sozu returns the DUSK in the same transaction, with no fee and no waiting.
- Gave stakes with Sozu a 5M gas limit and unstakes 10M, at the network's price, never under 2.5M and 4M.
- Showed a deposit to DuskEVM as To its DuskEVM address in Activity and its details, with Copy.
- Put the test network strip across the top of the full view, and kept it and the sidebar in place as the page scrolls.
- Asked to unlock before showing Contacts.
- Set section heads and balance labels in small capitals, the heads between grey brackets.
- Showed links and a transaction's ID in blue.
- Set addresses, IDs and block heights in Söhne Mono.
- Wrote times of day in the browser's own format, as the web wallet does.
- Shortened Staking's section head to Stake.
- Warned on a contact's page when its saved `.dusk` name has expired, isn't registered or has no address any more.
- Named whom a token approval lets spend in Activity, showed an allowance of 0 as a revoke, and listed approvals in the spender's contact Activity.
- Named the eye button Show balances while balances are hidden.
- Moved what a site's payment makes visible to everyone up, under the amount, in its approval window.
- Set every extension page's language to English.
- Showed the time zone with full dates and times in a transaction's details, the Sent screen and approvals.
- Moved Delete all contacts to Settings' Advanced, asking first, and showed each contact by its first letter.
- Kept Confirm and Approve off while a custom gas limit is under the minimum or the gas price is 0, with the reason under the field.
- Showed under Custom fee what the gas limit and price come to in DUSK.
- Showed a transaction's exact fee under Technical details.
- Said plainly that staking needs some public DUSK for the network fee, without an error before anything is typed.
- Kept Max on Staking to 4 decimals, and left the fee to unstake later.
- Named the profile on both staking Reviews by its `.dusk` name, and repeated before Confirm that it needs your own Dusk node.
- Showed on Sozu's Review what the stDUSK is worth now, and said why a contract call's fee cap is higher.
- Led Activity and a transaction's details with a saved contact's own name, its `.dusk` name beside it.
- Named Dusk Domains calls in Activity by what they did, such as "Registered a .dusk name", and Sozu's as "Staked with Sozu".
- Kept a deposit to DuskEVM's recipient with the transaction and showed it in its details.
- Stopped offering Add token and Import NFT on a contract call's details.
- Gave the site approval windows the calm look, with Reject and the approve button always in view, and the chain, node, function, call data and the site's own details under Details.
- Led a site's payment approval with the amount, the recipient's name and the fee.
- Said in the connect approval what a site sees and that it can't move funds without your approval, with its own wording for a request for the shielded address.
- Showed a saved contact's label beside the recipient's verified `.dusk` name in approvals, instead of in its place.
- Said on a public transfer's approval what becomes visible to everyone, and under which name.
- Showed what a site asks while the wallet is locked, with Reject beside Unlock.
- Showed the exact amount a site asks to send, every decimal.
- Refused `dusk_signMessage` strings that aren't hex or `base64:`-prefixed, instead of reading plain text as base64.
- Gave the popup a calmer look: lists on one surface, pill buttons, round home actions and plain section titles, in each system's own fonts.
- Reworked Staking into an overview with native and liquid staking as two equal choices, an amount screen that checks the 1,000 DUSK minimum as you type, and the owner and stake account under Advanced.
- Named Sozu as a third party wherever liquid staking shows, and said how much stDUSK a stake gets and what it's worth now.
- Showed toasts at the bottom of the popup, outside the page that scrolls, long enough to reach their action, and announced to screen readers.
- Showed errors under their field instead of only in a toast.
- Hid amounts in toasts and on the Sent screen while balances are hidden.
- Showed every amount and fee in one format: at most 4 decimals, no trailing zeros, thousands grouped, with DUSK; a fee's maximum rounds up, a fee paid to the nearest.
- Set fees at the network's gas price, with one Custom fee for your own limit and price, and a warning under the minimum gas limit as you type.
- Restyled Send, Shield and Unshield: one large amount field, what's available after fees with Max, and errors under the field.
- Stopped offering Save to Contacts for your own account or address.
- Restyled Receive, Contacts and Settings, and showed what a `.dusk` name reaches under it on Receive.
- Restyled the token and NFT screens, onboarding and Unlock, and kept the full view's pages to one readable column.
- Shortened every Dusk address, contract ID and transaction ID the same way, to its first and last six characters.
- Named a profile without a `.dusk` name by its label in the header, with its account in the tooltip and the profile switcher.
- Named profiles by their verified `.dusk` names in Settings and its profile pickers.
- Offered auto-lock after 5 or 15 minutes, 15 by default, or Off; an open popup nobody uses locks too.
- Asked before disconnecting all sites, and moved Reset wallet to the end of Settings.
- Showed Activity's rows with a direction icon and the other side's name first; a failed one says nothing was sent and the fee paid.
- Showed a synced transaction's time from its block, or Syncing… until its outcome comes.
- Reworked a transaction's details into a summary of who, how much and its status, then its date, memo, fee, profile and ID, with block and gas under Technical details.
- Hid Activity's amounts and a transaction's amount while balances are hidden; fees stay visible.
- Said known chain errors in plain words, with the chain's own under Technical details.
- Moved the account's explorer link from Home's History ↗ to the end of Activity, on the Dusk explorer instead of DuskScan.
- Cleared the wallet's transactions, shielded notes and history on reset.
- Removed Review's Cancel. ([#126])
- Cut repeated text across the popup, labelled its fields for screen readers and drew its icon buttons as SVG icons. ([#126])
- Opened Receive on the public account, as the web wallet does. ([web-wallet#970])
- Picked the profile to connect from option cards instead of a dropdown. ([#127])
- Opened the profile switcher from the header's account chip, with a copy button per account. ([#125])
- Moved Refresh from the header to the balance. ([#125])
- Showed Receive's name and short address in one-line fields with copy buttons. ([#125])
- Pinned the shared typed-data RC through JSR's npm compatibility registry for reproducible installs. ([#22])
- Used `@dusk/typed-data` for typed-data validation, hashing and signed-message construction. ([#22])
- Gated dApp RPC requests on the canonical method list before any permission lookup or approval prompt, so methods absent from the advertised surface are unreachable rather than merely undocumented. Deliberately refused methods still report why instead of "Unknown method".
- Defaulted public transfers to 2.5M gas, set gas minimums for shield (30M) and public staking (35M), and lowered the unshield minimum to 30M, matching the web wallet. ([web-wallet#969](https://github.com/dusk-network/web-wallet/issues/969))

### Security

- Encrypted contacts with a key only the unlocked wallet has, kept apart for each wallet, and moved plain ones in on the first unlock.
- Deleted contacts on Reset wallet, and started a new or imported wallet with none.
- Rejected non-integer and out-of-u8-range profile indices before BLS key derivation. ([#117])
- Pinned direct Noble dependencies to exact reviewed versions. ([#22])
- Typed-data signatures cover a domain-separated message rather than the bare 32-byte digest, so they cannot be produced by, or replayed as, a signature over a caller-supplied digest.

### Fixed

- Said a Sozu stake or unstake is on its way on Staking, not "Nothing staked yet", and showed it there as it completes.
- Refused anything too long to be a name that isn't an address at To, with Review off.
- Joined up an address a chat app broke with spaces, at To and in Contacts.
- Refused a contact whose address is already saved under another name.
- Refused a contact name that looks like a .dusk name it isn't saved from.
- Hid the fee on the Sent screen with Hide balances.
- Hid what Max fills in with Hide balances, until an amount is typed.
- Dropped the error under Send's form once the recipient changes, and said so in plain words.
- Said why Send's Review went back after a switch of wallet, profile or network.
- Showed a memo's text in the order it was written.
- Hid the gas used on a transaction's page with Hide balances.
- The Staking page shows what is staked with Sozu and how to unstake it, instead of saying nothing is staked.
- Review goes back to the form when the wallet, profile or network changes.
- A public send's Review says the recipient's account shows too.
- Hide balances also hides the fee on a transaction's page.
- Sozu's unstake says no Sozu fee, as a network fee still applies.
- A mistyped account is refused at the To field and in Contacts. A memo over the network's limit says so under the field.
- Typing a contact's name offers that contact before any `.dusk` name.
- A transaction the wallet can't build says nothing was sent, in plain words.
- A decimal comma in an amount no longer disappears: 0,1 is 0.1, not 1. Input that is no amount gets an error instead of being changed.
- Read balances and sent tokens built on the DRC20 standard from the token list, and took a contract as a token recipient or spender.
- Restarted an old background worker left running after an update, which stopped the wallet unlocking.
- Read a site's DRC20 token calls in the DRC20 standard's form, with their exact amount and accounts, and warned on a token call the wallet can't read.
- Turned the camera off when a scan is closed before the camera starts.
- Showed an unshield as an unshield to a profile that only got its change, and two shielded payments one block made to one address as two transactions.
- Showed a gas refund from another account's bridge call as received, not as a withdrawal from DuskEVM.
- Kept syncing Activity when a transaction's time or outcome can't be read, and read it on the next sync.
- Kept what another page read of a reset dev or local node's history, and none of the old chain's times or outcomes.
- Kept looking for a bridge transfer's payment after a search missed it, rather than waiting for it for good.
- Said Arrived on an earlier deposit to DuskEVM also after a later one was sent, and waited for a deposit the archive doesn't list yet rather than taking another's payment.
- Showed amounts under 0.01 DUSK to two significant digits, as the other Dusk apps do.
- Sent nothing to a .dusk name whose public account isn't a valid key.
- Named a call that replaces a .dusk name's records in Activity, as one that changes them.
- Named only calls to Sozu's own pool as Sozu stakes and unstakes in Activity.
- Kept a contract's "·" with its short ID and Copy when its row wraps.
- Refused a stake with Sozu too small to get any stDUSK, and said the minimum.
- Kept Confirm off on Send's Review when the bridge's 1 DUSK fee takes the whole amount.
- Underlined links in a row's text, such as Run a node.
- Fixed links sitting higher than the section head beside them.
- Hid controls that showed while hidden: Review's Use the network's price, Max on an empty Send, and Settings' custom gas fields when off.
- Kept a profile label being typed when Settings redraws, and saved it when the field is left.
- Made the profile and network menus work from the keyboard.
- Gave every popup screen a heading for screen readers.
- Accepted a `Uint8Array` message in `dusk_signMessage` in Chrome, whose extension messaging turns it into an object.
- Fixed the popup moving Receive's QR and Review's recipient below the rest of the page. ([#125])
- Raised the shielded (Phoenix) transfer default gas limit to 50M and its minimum to 30M so shielded sends clear the node's spend-gas admission floor.
- Preserved the active unlock form, including entered text and in-flight submission state, across passive rerenders. ([#110](https://github.com/dusk-network/wallet/issues/110))
- Cleared unanchored spent-note caches before resync to prevent orphaned notes from reappearing. ([#106](https://github.com/dusk-network/wallet/issues/106))
- Committed prefetched shielded chunks before stopping at the scan target, including under slow RPC responses.
- Discarded abandoned unlock metadata errors and notifications after session or sync changes.
- Kept concurrent metadata initialization from overwriting committed shielded cursors and anchors.
- Backported the upstream W3sper stream reader so interrupted reads surface errors and can be retried; retained the published SDK pin without adding dependencies.
- Validated shielded cache anchors and rebuilt invalidated notes/cursors together after a reorg, preserving pending reservations. Cursors now represent the next note position. ([#106](https://github.com/dusk-network/wallet/issues/106))
- Surfaced failed spent-note reconciliation instead of reporting a healthy sync. ([#107](https://github.com/dusk-network/wallet/issues/107))
- Cancelled stale shielded sync work after lock, profile or network changes, including preflight and cache writes. ([#108](https://github.com/dusk-network/wallet/issues/108))
- Disabled typed-data approval when complete disclosure cannot match the pending digest within display limits. ([#113])
- Flagged typed-data formatting controls, line separators and non-NFC text without normalizing signed values. ([#113])
- Displayed empty typed-data structs with their paths and types, including array elements and row-limit disclosure. ([#22])
- Replaced Arabic Letter Mark in typed-data domain and message previews with a visible placeholder and warning. ([#22])
- Counted completed typed-data signing requests as auto-lock activity. ([#22])
- Matched typed-data byte previews to every accepted hex spelling. ([#22])
- Applied message-preview safeguards to typed-data domain strings. ([#22])
- Required an exact typed-data chain match before approval. ([#22])
- Rejected undeclared non-enumerable and symbol-keyed fields in typed-data structs. ([#22])
- Returned `INVALID_PARAMS` with the typed-data error code for hash-time value validation failures. ([#22])
- Visibly disclosed truncated strings in typed-data approval previews. ([#22])
- Required identifier field names in typed-data schemas. ([#22])
- Rejected unpaired UTF-16 surrogates in typed-data strings. ([#22])
- Updated the dApp quick start to use conflict-aware provider selection. ([dusk-network/connect#42](https://github.com/dusk-network/connect/issues/42))
- Serialized DRC20 and DRC721 encoded call arguments before browser extension messaging. ([#79])
- Generated fresh discovery UUIDv4 values per page/provider, separate from the stable bridge routing identifier. ([dusk-network/connect#42](https://github.com/dusk-network/connect/issues/42))
- Waited for the archive to have every block a shielded history needs, rather than keep it incomplete.
- Marked an unshield as Shielded in the export.
- Marked a deposit to DuskEVM Arrived only on the bridge's payment of a deposit from the same account.

[#22]: https://github.com/dusk-network/wallet/issues/22
[#113]: https://github.com/dusk-network/wallet/issues/113
[#117]: https://github.com/dusk-network/wallet/issues/117
[#125]: https://github.com/dusk-network/wallet/issues/125
[#126]: https://github.com/dusk-network/wallet/issues/126
[#127]: https://github.com/dusk-network/wallet/issues/127
[#130]: https://github.com/dusk-network/wallet/issues/130
[web-wallet#970]: https://github.com/dusk-network/web-wallet/issues/970

## [0.3.0] - 2026-06-23

### Added

- Added contact detail views with full saved addresses, Edit and Send actions, filtered local activity, and public explorer History links. ([#61])
- Added full receive-address display and QR PNG export from the receive view. ([#60])
- Added saved-contact badges to recent activity when the outgoing recipient matches an address book contact. ([#61])

### Changed

- Replaced the History tab with inline recent activity and explorer History access. ([#59])
- Componentized popup subnav headings and transfer recipient badges for more consistent wallet UI. ([#58], [#62])
- Improved public, shielded, and contact recipient badges across send, shield, and unshield flows. ([#62])
- Tightened wallet form behavior so value fields reject text input and Enter continues supported flows. ([#57])

### Fixed

- Fixed extension worker loading under browser extension content security policies. ([#62])
- Fixed auto-lock activity tracking across background worker restarts and preserved connected dApp locked-state profile events. ([#70])
- Kept account-type detection pills compact when adding or editing contacts. ([#61])

## [0.2.0] - 2026-06-18

### Added

- Added a repository privacy policy document for wallet extension store submissions. ([#29])
- Added owner-aware native staking position flows. ([#32])
- Added Sozu liquid staking support with hub discovery and live pool reads. ([#33])
- Added a Shield action to the full wallet view navigation. ([#43])

### Changed

- Changed the default wallet network from Testnet to Mainnet.
- Updated wallet-core to 1.7.1. ([#47])
- Updated dashboard action icons and extension icon contrast. ([#42], [#46])
- Clarified the transfer amount control and connected-site status UI. ([#44], [#45])
- Polished wallet copy across staking and other user-facing flows. ([#52])
- Updated the audited development toolchain so `npm audit` is clean. ([#55])

### Fixed

- Allowed users to retry approval unlocks after entering a wrong password. ([#41])
- Refreshed full-view lock state when the wallet auto-locks in the background. ([#51])
- Scoped provider bridge messages to Dusk Wallet so another installed Dusk provider does not receive the same dApp request. ([#53])

### Security

- Restricted dApp RPC and custom node switching to HTTPS origins/endpoints or local HTTP development endpoints. ([#54])

## [0.1.0] - 2026-05-28

### Added

- Added Chrome and Firefox extension builds for Dusk Wallet v0.1.0.
- Added wallet onboarding, mnemonic import, vault creation, unlock, lock, and auto-lock flows.
- Added profile-based account management aligned with Dusk Connect and the injected provider profile API.
- Added public account balance display and Phoenix/shielded balance display with shielded sync status.
- Added public transfer, shielded transfer, shielding, and unshielding flows.
- Added transaction activity and detail views with explorer links, fee details, execution state, and local wallet metadata.
- Added Dusk provider support for dApp profile connections, `dusk_requestProfiles`, `dusk_profiles`, `profilesChanged`, and `dusk_disconnect`.
- Added explicit shielded receive-address approvals through `dusk_requestShieldedAddress`.
- Added dApp approval flows for transactions, message signing, auth signing, contract calls, and watched assets.
- Added DRC20 and DRC721 watch-asset support.
- Added DRC20 transfer/approve UI and DRC721 import/detail support.
- Added data-driver backed decoding for known DRC20 and DRC721 contract-call approvals.
- Added sign-message approval previews for readable messages, with hash/length-only treatment for opaque byte payloads.
- Added gas editor controls and cached gas-price suggestions for transaction review flows.
- Added Phoenix-aware transfer gas defaults.
- Added expanded transaction lifecycle states for submitted, mempool, executed, failed, removed, and unknown transactions.
- Added mempool/chain reconciliation for submitted transactions when watcher state is incomplete.
- Added conservative Phoenix pending-nullifier reservation tracking for shielded transactions.
- Added a Phoenix spend mutex to prevent concurrent shielded sends from building against the same spendable note set.
- Added safe recheck support for old local transaction reservations.
- Added wallet e2e mnemonic import fixes so the Playwright flow can act as a release signal.
- Added Chrome Web Store and Firefox Add-ons release metadata and packaged build support.

### Changed

- Aligned public wallet docs with the profile provider API and v0.1 release/security guidance.
- Updated transaction copy so watcher timeouts and unknown Phoenix states do not read as execution failure.
- Updated activity and transaction-detail tone for unknown/removed states so they no longer visually imply failure.
- Updated provider responses so internal Phoenix pending-nullifier metadata stays wallet-local.
- Updated dApp transaction defaults and validation so transfer gas defaults are privacy-aware.
- Hardened dApp origin isolation and permission scoping.
- Hardened sensitive provider method validation for transactions, message signing, auth signing, and watched assets.
- Hardened vault and lock lifecycle behavior, including locked-wallet provider responses.
- Updated extension packaging, metadata, and store assets for the v0.1.0 release.
- Reduced browser extension polyfill, remote-code, and bundled dependency surface for v0.1.

### Fixed

- Prevented watcher timeout/unknown Phoenix transactions from being shown as execution failures.
- Prevented Phoenix pending-nullifier reservations from being automatically released on timeout, unknown status, removed status, or a single missing mempool poll.
- Prevented provider responses from leaking local pending nullifiers.

[Unreleased]: https://github.com/dusk-network/wallet/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/dusk-network/wallet/compare/v0.3.0...v0.4.0
[#79]: https://github.com/dusk-network/wallet/issues/79
[#80]: https://github.com/dusk-network/wallet/issues/80
[0.3.0]: https://github.com/dusk-network/wallet/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/dusk-network/wallet/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/dusk-network/wallet/releases/tag/v0.1.0
