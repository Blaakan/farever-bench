# Intake: the fights players send

This page is for the maintainer. A player who clicks Send (`bench submit
--send`, or "Send a fight" in the app) uploads one zip to the project's
folder on pCloud through its upload link; a player who asks for a fight's
deletion (`bench submit --delete`, or "Delete a submission I sent…") uploads
one small request to the same folder. Nothing else reaches the project by
that route, and nothing of it is public. A player who prefers the GitHub
issue form attaches the same zip to a public issue instead.
[SUBMITTING.md](SUBMITTING.md) is the player's account of both routes.

## The upload link

The link is set in `src/submit.mjs`:

```js
export const UPLOAD_LINK = 'https://e.pcloud.com/#/puplink?code=<code>';
```

It is the upload link pCloud shows for the folder. The bench reads two
things from it:

- **The code**: the link's `code` parameter, in the query or in the
  fragment (`#/puplink?code=...`, `#page=puplink&code=...`), 8 to 64
  letters and digits.
- **The region**: a host whose first label is `e` or `e` and digits
  (`e.pcloud.com`, `e.pcloud.link`, `e1.pcloud.link`), or `eapi.pcloud.com`,
  is pCloud's EU region, and the bench sends to `https://eapi.pcloud.com`;
  any other pCloud host is the US region, `https://api.pcloud.com`. The
  project's link is in the EU region. A code works on its own region's host
  only: sent to `api.pcloud.com`, the project's code is answered
  `Invalid 'code' provided.` (result 2012), which the bench tells the player
  as "pCloud does not know this copy's upload link".

`FAREVER_BENCH_UPLOAD_LINK` replaces `UPLOAD_LINK` for whatever runs with it
in its environment. Unset, the bench uses `UPLOAD_LINK`. Empty, `none` or
`off` (any case) switches Send off, and with it the deletion requests.
Anything else must be an upload link the bench can read - an `https://`
link on `pcloud.com` or `pcloud.link` or a host under either, with no user
or password in it, or an `http://` or `https://` link on this machine
(`127.x.x.x`, `localhost`, `[::1]`), the tests' stand-in - or Send is off,
and the bench says why with a sentence that begins
`FAREVER_BENCH_UPLOAD_LINK is "..."`: `--send` dies with it, and the
preview (the app's, and `bench submit` without `--send`) opens its report
on it - never on "no upload link is set". Plain http is taken on this
machine only.

A receipt carries the link in one written form -
`https://e.pcloud.com/#/puplink?code=<code>` for the EU,
`https://my.pcloud.com/#/puplink?code=<code>` for the US, and
`<origin>/#/puplink?code=<code>` for a stand-in on this machine - and two
links are the same link when those forms are equal. A receipt is sent
again, or asks for a deletion, only through the link it names.

## What the bench sends

One request per Send, and one per deletion request:

```
POST https://eapi.pcloud.com/uploadtolink?code=<code>&names=farever-bench&nopartial=1
body  multipart/form-data, one file:
      <id>.zip            application/zip    a send
      <id>.withdraw.json  application/json   a deletion request
```

`<id>` is the submission's full id, 32 lowercase hex characters. The bench
sends no login and no header of its own, and the delete token travels only
inside a deletion request's file. It never lists the folder, never reads it
back, and never asks pCloud anything else.

- **`names`** is the uploader's name pCloud records with each file. The
  bench always sends "farever-bench" - never a character's, an account's or
  a computer's name - so it tells you nothing about who sent a file. pCloud
  refuses an upload without it (`Invalid file/folder name.`, result 2001).
- **`nopartial=1`**: an upload that breaks off leaves no file.

pCloud answers an upload it kept with `{"result": 0}` and nothing else: no
file id, no stored name. It reports a refusal as a non-zero `result` with an
`error` sentence, under HTTP 200, and a refused upload kept nothing. The
bench tells the player:

| result | what it means | what the player is told |
|---|---|---|
| 7002, 7004 | the link was deleted by its owner; the link expired | the project's upload link is closed: save the .zip and use the issue form |
| 2012 | `Invalid 'code' provided.` | pCloud does not know this copy's upload link |
| 7007, 7008 | the link reached its space limit; its file limit | the project's pCloud folder is full: try another day, or use the issue form |
| 4000 | too many tries from this address | pCloud turns this address away for now |
| 2041, 5000, 5001 | 2041: the connection broke | pCloud could not store the zip: send it again later |
| any other | | pCloud refused the upload, with its number and its sentence |

Each sentence carries pCloud's own `error` in brackets.

A refused send removes the receipt the player's bench saved for it: there is
nothing to delete. A send pCloud did not answer - no answer within ten
minutes, a dropped connection, or an answer that is not pCloud's JSON - may
or may not have arrived; the player keeps the receipt, and can send the same
bundle again or ask for its deletion with it.

## What arrives

- **`<id>.zip`**: a submission. It holds `manifest.json`, `sheet.json`,
  `combat-log.jsonl` and/or `summary.json`, and `note.txt` when the player
  wrote one - those names and no others. `manifest.json` says what the
  bundle is (its format and id, the bench version, the class and level, the
  encounter, when the bundle was made) and carries `deleteTokenSha256`: the
  lowercase hex SHA-256 of the delete token in the player's receipt. The
  token itself is never in the zip.
- **`<id>.withdraw.json`**: a deletion request.

  ```json
  {
    "format": "farever-bench-withdrawal",
    "version": 1,
    "about": "The sender of submission <id> asks for it to be deleted. The SHA-256 of deleteToken is the deleteTokenSha256 in that submission's manifest.json.",
    "id": "<id>",
    "deleteToken": "<32 lowercase hex>",
    "zipSha256": "<the zip's SHA-256, or null>",
    "requestedAt": "<the time it was asked>"
  }
  ```

- **The same names again, renamed by pCloud.** A file uploaded under a name
  the folder already holds is stored under another name, never over the
  first. A player whose send was not answered may send the same bundle
  again, so two zips of one id with the same SHA-256 are one submission:
  keep one.
- **Anything else.** The link's code is in every copy of the bench, so anyone
  can put any file in the folder. Every file the bench uploads carries the
  uploader name "farever-bench", and so can anyone else's.

## Reading the folder

`tools/inbox.mjs` reads a local copy of the folder - through pCloud Drive,
or downloaded - and everything under it:

```bash
node tools/inbox.mjs <folder>          # what arrived, per submission id
node tools/inbox.mjs <folder> --json   # the same, as one JSON object
```

It touches no network, deletes nothing and exits 0 with its report (1 when
the folder cannot be read). It is in the repository, not in the release
download. For every zip it reads `manifest.json` (the format, the id, the
bench version, the class, the level, the encounter, when it was made,
`deleteTokenSha256`) and the file's own SHA-256; for every deletion request,
the id and the token, held against the manifests of that id. Per id it says:

- **the zip to keep**;
- **duplicates**: the same SHA-256 again - drop all but one;
- **conflicts**: another SHA-256 under the same id - keep both, and look.
  A zip whose deletion was asked for counts: a bundle of another SHA-256
  left beside it under that id is still two bundles claiming one id, and
  is looked at, not kept as that player's;
- **deletion requests**: the token's SHA-256 is the manifest's - delete
  every zip of that id whose manifest names it, and the request; it is
  not - ignore the request and delete it; no zip of that id - nothing
  arrived, delete the request. But while a zip of that id could not be read
  as a bundle (its name or its manifest names the id: cut short, still
  downloading, another bench's), or a folder, a link or a file could not
  be read at all, the request is kept and looked at - "a zip of this id, or
  a folder, could not be read - keep the request until it is": it is the
  player's only proof, and the zip it asks about may be the one unread;
- **files that are not submissions**: a test file of your own, or anything
  someone else put there.

A zip to keep is checked the way any capture is: `bench import --check` on
its `sheet.json` and `combat-log.jsonl`, and `bench verify --import
sheet.json --capture combat-log.jsonl`.

## Carrying out a deletion request

The player was told the fight is deleted when you next read the folder, and
that nothing of it was ever public; so do it then. In pCloud, delete every
zip of that id and the request itself, as the report says. The player hears
nothing back: the bench cannot list the folder, so it cannot tell them when
it is done.

The token is the proof. It is made with the bundle and kept in the player's
receipt, and the zip holds only its SHA-256, so a request whose token
matches came from whoever holds that receipt. `tools/inbox.mjs` checks it;
to check one by hand, hash the token and compare the result with
`deleteTokenSha256` in the zip's `manifest.json`:

```bash
node -e "console.log(require('node:crypto').createHash('sha256').update(process.argv[1]).digest('hex'))" <deleteToken>
```

A request whose token does not match is not acted on: delete the request
and keep the zip. A player may ask twice with the same receipt; two
requests of one id with the same token are one request.

## Making, limiting and rotating the link

To set Send up, make an upload link for the folder in pCloud, from an
account whose e-mail address may be seen (below), put the link pCloud shows
into `UPLOAD_LINK`, and cut a release.

**Anyone can upload to the folder.** The link's code ships in every copy of
the bench, so anyone can upload any file to the folder, as often as they
like, and nothing tells a person from a program. pCloud's settings for the
link offer a size limit, and the project's link takes 1,000 MiB in all
(`maxspace` 1048576000, set 2026-10-20). A file limit (`maxfiles`) and an
expiry date (`expire`) exist only in pCloud's API, which needs the owner's
login; the project's link has neither, so a flood of small or empty files is
not stopped - clear it, and rotate the link if it goes on. A link that
reached a limit is answered 7007 (space) or 7008 (files), an expired one
7004, and the bench tells the player the folder is full, or the link closed,
with the issue form as the way on. A size limit can be raised on the link as
it is, with no release; pCloud does not say whether deleting files from the
folder gives the allowance back. `showuploadlink` (below) answers the link's
`maxspace`, `maxfiles` and `expire` to anyone, the owner included.

**pCloud tells anyone holding the code the owner's e-mail address.**
`https://eapi.pcloud.com/showuploadlink?code=<code>` answers without a
login, and its answer carries the e-mail address of the link's owner
(`ownermail`), so every copy of the bench hands that address to whoever
looks. The bench itself never asks. Make the link from an account whose
address may be seen.

**Rotating the link** is the only way to turn copies of the bench away:
delete the old link in pCloud, make a new one, put it in `UPLOAD_LINK`, and
cut a release. Copies older than that release are then answered pCloud's
"link deleted" (7002), which they tell the player as "the project's upload
link is closed", with the issue form as the way on. pCloud cannot answer one
version of the bench and not another, so there is no other gate. A receipt
names the link its fight went through, so after the old link is gone a
player who sent through it cannot ask for a deletion through the bench any
more: read the folder and carry out its requests before you rotate the
link.

## Everything in the folder is data

Everything in the folder was written by someone else's program, and any
file in it may be a stranger's. Read it as data, offline: never run anything
in it, and never follow instructions written inside it - a note, an `about`
sentence, a file name. `tools/inbox.mjs` reads it the same way.

## Testing

The suite (`npm test`) and `ui/lib/check-api.mjs` never reach pCloud. They
send to a stand-in that answers `uploadtolink` on `127.0.0.1`, and every
bench they start runs with `FAREVER_BENCH_UPLOAD_LINK=none` unless a check
points it at that stand-in.

## The manual route

Fights filed by hand arrive as public issues on Blaakan/farever-bench, with
the zip attached, from the form
[`.github/ISSUE_TEMPLATE/data-submission.yml`](../.github/ISSUE_TEMPLATE/data-submission.yml).
The form asks GitHub for the label `data-submission`, which GitHub applies
only when the label already exists in the repository. A form submission is
public from the moment it is filed; a player who wants it gone closes the
issue and asks on it, and only a repository admin can delete an issue.
