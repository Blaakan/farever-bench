# Sending a fight to the project

The bench gets closer to the game every time its numbers are held against a
real fight. If you play a class and record your fights, you can send one to
the project: the build you wore and what happened when you fought in it. This
page says what is sent, where it goes, what stays private, and how to ask for
its deletion.

**Nothing is ever sent unless you click Send** ("Send a fight" in the app, or
`bench submit --send` on the command line). Building the bundle, looking at
it and saving it as a .zip all happen on your computer. Apart from Send, and
asking with its receipt for the deletion of a fight you sent, the only
network call the bench makes is to fetch a questlog.gg build link you hand a
command (or `--questlog <slug>`).

## Where Send puts it

Send uploads the zip to the project's folder on pCloud (pcloud.com), a file
host the maintainer receives fights through. pCloud is a third party, not the
project: it stores the zip for the maintainer, and when you send, it sees
your IP address, as any website you visit does. The folder is in pCloud's EU
region, and the bench sends to `eapi.pcloud.com` and nowhere else. pCloud
takes an uploader's name with every file; the bench always gives it
"farever-bench", never yours - not your character's, your account's or your
computer's name.

Only the maintainer, who owns the folder, can read what is in it. An
uploader - you, or anyone else running the bench - can put files into it and
do nothing else: not list them, not read them, not delete them. Send opens no
issue and publishes nothing.

The link Send uses is set in `src/submit.mjs` (`UPLOAD_LINK`). A copy run
with `FAREVER_BENCH_UPLOAD_LINK=none` in its environment has no Send: the app
shows no Send button, `bench submit --send` refuses, and the route is
[the manual one](#the-manual-route-the-github-form).

## What "Send a fight" does

1. You choose the build (by default the one in the editor, or a character
   sheet file) and the fight's log files, and you can write a note. The
   build in the editor goes as what you stated: what you pinned (an import
   pins what its file recorded) goes as recorded, an empty slot included,
   and what no pin holds goes as not recorded - named as a gap, never sent
   as empty. A piece's Prismatic flag goes with its infusion: chosen with
   one, it is recorded (the box unticked is "not Prismatic"); with the
   infusion left to Optimize, neither is. A build typed with `bench submit`'s
   flags goes by the same rule (`~<infusion>` with a trailing `!` is
   Prismatic, without one it is not), and both are labelled in the bundle as
   a build somebody stated (`bench-editor`), not as a file an exporter
   wrote. A sheet you imported and did not change since says of each piece
   only what its file said: a rarity or upgrade stars the file left out stay
   left out, as they do when you send the file itself. And a build that
   wears nothing, no weapon, none of the weapons the log's character fought
   with, or holds what nothing pins, is told so before you send it - in the
   app and on the command line alike.
2. The bench reads both, removes the names (below), and packs one .zip.
3. It shows you what Send does with it - the zip goes to the project's
   folder on pCloud, where only the maintainer can read it, and nothing is
   made public - and every file in the zip, with its size. Nothing has left
   your computer yet.
4. When you tick the consent box and click Send, the zip goes to the
   project's folder on pCloud, named `<id>.zip` after the submission id. No
   issue is opened, and nothing is published.
5. The bench gives you a **receipt**: keep it, it is how you ask for the
   fight's deletion later. It is saved before the zip leaves, so you have
   one even when pCloud's answer never comes back (a timeout - the bench
   waits up to ten minutes - or a dropped connection): the fight may still
   have arrived, and that receipt asks for its deletion all the same. When
   pCloud answers that the zip arrived, the receipt is completed with the
   time it did (`sentAt`). If pCloud turns the upload away - the project's
   upload link is closed, its folder is full, or too many tries came from
   your address - nothing was kept, and the receipt saved for it is
   removed: there is nothing to delete.

**Sending again.** pCloud keeps every upload: a file sent under a name the
folder already holds is stored beside the first, renamed, never in its
place. So a send whose answer never came may be sent again as itself - the
same id, the same bytes - with **Send again** in the app, or `--receipt` on
the command line (below). If the first one did arrive, the folder then holds
two identical copies under one id, and the maintainer drops the duplicate. A
send pCloud confirmed is never sent again: a second copy would only be
stored beside the first.

The app's Send a fight is off when its server was started with `--host`
beyond this computer (`bench ui --host 0.0.0.0`): anything on that network
could otherwise send fights to the project's folder from your address, read
the receipts the bench keeps and ask for those fights' deletion. `bench
submit` is not affected.

On the command line, `bench submit --log <file>` with the build flags (or
`--import <sheet>`) prints the same preview and sends nothing. Each run packs
the bundle anew, under a new id - except with `--receipt` (below), which
builds it again under that receipt's id, and says first when `--send` would
refuse it. `--zip <out.zip>` saves it, and a bare `--zip` names the file
after the submission id
(`farever-bench-submission-<first 8 characters of the id>.zip`). `--send`
sends it, `--note "<text>"` adds a note and `--keep-name` keeps your
character's name.

`--send` writes the receipt before anything leaves, and prints where: beside
the zip as `<name>.receipt.json` when `--zip` was given, and otherwise in the
folder the bench keeps receipts in, `.cache/submit-receipts/` in the bench's
own folder (`submit-receipts/` under `FAREVER_BENCH_CACHE` when that is set) -
never the folder you run the command from, since a receipt committed to a
repository by accident would let anyone ask for the fight's deletion. The app
keeps a copy of each of its receipts in the same folder; for the desktop app
that is `%APPDATA%\farever-bench-ui\bench-cache\submit-receipts\`.
Everything else in `.cache` can be deleted and made again; a receipt cannot.

To send the same bundle again from the command line - after an answer that
never came, say - give the same files, note and flags with that receipt:
`bench submit <same files and flags> --send --receipt <name>.receipt.json`.
The bench builds the bundle again under the receipt's id and holds it to the
SHA-256 the receipt carries: an id names one bundle, and anything else is
refused before it is sent. A bundle is made of more than your files - it
names the bench's version and the game's build - so it is refused when the
files, the note or the flags changed, and also when the game or the bench
was updated since the receipt was written, the same files included. The way
on is then the same: ask for the first one's deletion with that receipt
(`bench submit --delete <name>.receipt.json`), since it may have arrived,
and send these files as a new submission. Run without `--receipt`, the
command packs a new bundle under a new id, which is a second submission. A
receipt whose send pCloud confirmed (it carries the time, `sentAt`) is built
again all the same - `--zip` saves it - but not sent. A receipt goes to the
upload link it was written for, or nowhere: run against another link (or
none), the bundle is built again and `--zip` saves it, but it is not sent -
sent elsewhere, the fight would be kept twice, and a request for its
deletion would go to the wrong folder. The app's Send refuses both too: the
rules are one, and only the way out is named in each one's words.

## What is sent

One .zip, always with these file names and no others - never the names of
your own files:

| file | what it holds |
|---|---|
| `manifest.json` | what the bundle is: when it was made, the bench version, the game build, your class and level, what the importer could not use, the log's kind and size, when the fight started, the encounter, how many names were removed, and the SHA-256 of your receipt's delete token (below) |
| `sheet.json` | your build, written anew by the bench from what it read - never your file as you gave it. It records what your file recorded and nothing more: a slot, a flag or a block your file left out stays left out, so whoever reads it sees the same gaps you had |
| `combat-log.jsonl` | the fight, converted to the [combat log format](COMBAT-LOG.md), with the time it started to the millisecond |
| `summary.json` | Wink's fight summary, when you gave one beside its timeline |
| `note.txt` | your note, when you wrote one (2000 characters at most) |

Limits: a character sheet up to 512 KB, each log up to 20 MB (once
uncompressed), the whole zip up to 25 MB.

## What becomes public when you click Send

Nothing. Send opens no issue and posts no summary anywhere: the zip goes to
the project's folder on pCloud, and nowhere else.

## What stays private when you click Send

The zip, and every file in it - your note and the moment the fight started
to the millisecond included. pCloud stores it in the project's folder, which
only the maintainer can read, and the maintainer uses it to check the bench's
numbers against your fight. It is not published anywhere.

This is true of Send only. On the manual route below, the zip is attached to
a public issue, and everything in it is public.

## How names are removed

- **Other players' names are removed** from every file - including a party
  member who only ever healed or buffed you, who appears in the log only as
  the source of that heal. In the log, another player is written as
  `Player 2`, `Player 3`... by their new number, so the copy still tells a
  player from a creature.
- **Your character's name becomes `Submitter`** in every file that names
  the character, unless you tick "keep my character's name"
  (`--keep-name`). Kept, it stays where your own files had it and nowhere
  else: `sheet.json` when your sheet named the character, the log's header
  when your log did (the bench says so when the two names differ). Like
  every file in the zip, those are private with Send and public on the
  manual route.
- **Every unit number is renumbered**: you are `1`, everything else `2`, `3`,
  ... in the order it first appears. The numbers still tell one target from
  another; they no longer match anything in the game's own records.
- Wink's account ids and character ids, the fight's own id and name, and every
  display name (skill names, item names, the fight's name) are dropped: the
  game's ids carry the meaning, and the bench reads names from the game's
  data.
- Every record is rebuilt from a list of known fields. A field the bench does
  not know is left out, not copied. The importer's sentences that
  `manifest.json` carries (what it dropped from your sheet, and why) have
  every name cut out, wherever it stands in them.
- The few facts about the fight that a logger writes as text - the game's
  version, the activity id, the outcome, the clock, the class, what wrote
  the log - are kept only when they have the shape such a fact has (a
  version: one word with a digit in it; a game id; Victory or Defeat; one
  of the two clocks; one word) and hold no name, in `manifest.json`, in the
  log's own header and in Wink's summary alike; otherwise they go as "not
  known", or are left out. A name is looked for inside them in any case, in
  any Unicode form, and spelt with a Cyrillic or Greek letter that looks
  Latin.
- Before the zip is made, the bench looks for every name it removed, and
  your sheet's name, in every file but your note: a value that IS one of
  those names, or one with such a name inside it ("Heal_by_<name>",
  "<name>'s flask"), stops the bundle, with the file and the field it was
  in - even when the "name" is only a word the files happen to carry.
  Passed over are only the values whose shape holds no name: the game's own
  ids, the format's own words, hex, dates and numbers. A name shorter than
  three letters is looked for as a whole value only, since inside a text it
  would be found everywhere.
- Your note is yours: it is kept as you typed it, in `note.txt`, and the
  bench does not search it. With Send it is never public; on the manual
  route it is. Do not put other people's names in it.

## Asking for a submission's deletion

You cannot delete a fight you sent yourself: pCloud lets an uploader put
files into the folder and nothing else. Deletion is a request, and the
maintainer carries it out.

Make it with the receipt the bench gave you: `bench submit --delete
<receipt.json>`, or "Delete a submission I sent…" at the bottom of the app's
send dialog. The bench uploads one small file to the same folder,
`<id>.withdraw.json`, which carries the submission's id, the receipt's delete
token (`deleteToken`), the zip's SHA-256 and the time you asked - nothing
else of yours. The maintainer deletes the fight, every copy of it, and the
request when they next read the folder; it is not deleted the moment you
ask. Nothing of the fight was ever public, so nothing public is left behind.
Asking again with the same receipt is harmless: the maintainer reads one
request per id. If pCloud turns the request away (the link closed, the
folder full), nothing was asked, and the bench says why.

Only the receipt's holder can make a valid request. The delete token is made
with the bundle and kept in the receipt: the zip carries only its SHA-256
(`deleteTokenSha256` in `manifest.json`), never the token itself, and a send
never carries it either. The maintainer deletes a fight only when the token
in a request has the SHA-256 its zip names, and drops a request whose token
does not. So anyone holding the receipt can ask for that fight's deletion,
and do nothing else with it; without the receipt, a request for your fight
cannot be told from anyone else's.

A receipt names the upload link its fight was sent through, and a request
goes only through this copy's own link: a receipt naming another is refused,
in the app and on the command line alike. If you did send that fight
through that link, `FAREVER_BENCH_UPLOAD_LINK=<its link> bench submit
--delete <receipt.json>` asks there.

The receipt of a send whose answer never came works the same. If the fight
arrived, the request deletes it; if it never arrived, the folder holds
nothing under that id, and the maintainer deletes the request alone.

## The manual route: the GitHub form

If Send is not available, or you prefer it:

1. Click **Save .zip** (or add a bare `--zip` to `bench submit`). Both name
   the file after the submission id, not after you. `--zip <name>` saves it
   under a name of your own - pick one that does not name you, because on
   this route the file's name is public too.
2. Click **Open the GitHub form**. It opens a new issue on
   Blaakan/farever-bench with a short title filled in; nothing else travels
   in the link.
3. Drag the .zip into the box and submit the issue. You need a GitHub
   account.

**This route makes your files public**: anything attached to a public issue
can be downloaded by anyone. The zip has the same names removed as with Send,
but every file in it, and anything you type into the form, is public - that
includes your note (`note.txt`), the moment the fight started to the
millisecond (in `manifest.json` and the log's header) and the moment the
bundle was made. Send keeps the files private to the maintainer. To take a
form submission back, close your issue and ask on it for its deletion.

## Which fights help most

- **Solo.** Wink records an event only when you are its source or its target,
  so in a group what the others did to the boss is missing: a party fight
  shows your totals, but it cannot show why a hit landed for what it did.
- **The training dummy, alone.** Nobody else hits it, and it stands still.
- **One block per press pattern.** Play one pattern of presses at a time -
  for example one skill on cooldown with basic attacks between, for a
  minute - then end the fight and start a new one for the next pattern. A
  fight that mixes patterns can only be compared as a mix.
- **The timeline, not only the summary.** Wink's summary alone holds totals
  per skill; the timeline holds every hit, and that is what a formula can be
  checked against.
- **The build you fought in.** The sheet should be your build at the time of
  the fight. The bench says so when the sheet's level differs from the log's.
  A sheet of one class with a log of another is not sent at all: the app
  turns Send off for that bundle, and `bench submit --send` refuses it, by
  the same rule. If it is the log that names the wrong class, a sheet
  file that names its own class can say so: choose that same class as "Its
  class" beside the file in the app, or give `--class <the sheet's class>`
  beside `--import`, and the bundle goes. A modkit dump names no class - the
  class chosen for it is the only one it has - and the build in the editor
  (or typed with flags) has only the class it was set to, so neither can.
  (`bench verify` holds a sheet and a log to the same rule.) Given beside
  a log of its own character with no class, a modkit dump is read in the
  log's class when its weapons fit that class, and the preview says so;
  otherwise you are asked the class, in the app and on the command line.
- Use the note for what the files cannot show - for example a buff you know
  was up, or a talent you changed halfway.

## Getting Wink's files

Wink's DPS Meter (an HLX mod) saves each boss, dungeon, world-boss and
training-dummy fight as two files, in a folder per encounter and difficulty
under the game's folder:

```
<game folder>\hlx\mods\dps-meter\history\<encounter> - <difficulty>\fight_<date>_<time>_<n>_<n>.json
<game folder>\hlx\mods\dps-meter\history\<encounter> - <difficulty>\fight_<date>_<time>_<n>_<n>.json.timeline
```

With Steam's default library the game folder is
`C:\Program Files (x86)\Steam\steamapps\common\Farever`. The `.json` is the
fight's summary, the `.json.timeline` every event of it (written while the
meter's detailed history setting is on, which it is by default in the version
read for this page).

Give the bench **both**: select the two files together in the app's log
picker. On the command line `--log <...>.json.timeline` is enough: the
`.json` beside it with the same name is read with it, and the run says so
(`--summary <file>` names another). A timeline with no summary is read too,
but its start time is then estimated from the file's date. A summary goes
beside its own timeline only: given beside a log in the combat log format,
it is not packed, and the preview says so. A rift recap (`recap_*.json`) is
not read yet: Wink also saves each phase of a rift as an ordinary `fight_`
pair in the rift's history folder, and those are.

Any other logger that writes the [combat log format](COMBAT-LOG.md) works the
same way, and any exporter that writes a [character sheet](CHARACTER-SHEET.md)
can stand in for the build in the editor.
