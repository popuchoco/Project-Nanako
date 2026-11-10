"""Protocol smoke test for the isolated Nanako SMB candidate POC.

Requires Impacket 0.13.x and a running tools/smb-poc harness on loopback.
This is a test utility, not part of the Nanako runtime.
"""

import os
import uuid

from impacket.smbconnection import SMBConnection, SessionError
from impacket.smb3structs import (
    FILE_APPEND_DATA,
    FILE_CREATE,
    FILE_NON_DIRECTORY_FILE,
    FILE_READ_DATA,
    FILE_SHARE_DELETE,
    FILE_SHARE_READ,
    FILE_SHARE_WRITE,
    FILE_WRITE_DATA,
    SMB2_DIALECT_311,
    SMB2_SESSION_FLAG_ENCRYPT_DATA,
    SYNCHRONIZE,
)


HOST = "127.0.0.1"
PORT = 4445


def connect(username: str, password: str) -> SMBConnection:
    connection = SMBConnection(
        HOST, HOST, sess_port=PORT, timeout=8, preferredDialect=SMB2_DIALECT_311
    )
    connection.login(username, password)
    return connection


def denied(label: str, operation) -> None:
    try:
        operation()
    except SessionError as error:
        print(f"PASS {label} denied status=0x{error.getErrorCode():08x}")
        return
    raise AssertionError(f"{label}: operation unexpectedly succeeded")


def main() -> None:
    alice_password = os.environ["SMB_POC_ALICE_PASSWORD"]
    bob_password = os.environ["SMB_POC_BOB_PASSWORD"]
    nonce = uuid.uuid4().hex[:12]
    filename = f"poc-alice-{nonce}.txt"
    dirname = f"poc-alice-{nonce}"
    renamed_dir = f"{dirname}-renamed"

    alice = connect("alice", alice_password)
    session = alice.getSMBServer()._Session
    assert alice.getDialect() == SMB2_DIALECT_311
    assert session["SigningActivated"] is True
    assert session["SessionFlags"] & SMB2_SESSION_FLAG_ENCRYPT_DATA
    print("PASS dialect=SMB311 signing=True encrypted_session=True")

    try:
        tree = alice.connectTree("alpha")
        entries = alice.listPath("alpha", "\\*")
        assert any(entry.get_longname() == "poc-readme.txt" for entry in entries)
        received = []
        alice.getFile("alpha", "\\poc-readme.txt", received.append)
        assert b"".join(received) == b"Synthetic SMB POC data.\r\n"
        print("PASS alice alpha list/read")

        # Include FILE_APPEND_DATA: writing past EOF requires it for this
        # candidate; Impacket's storeFile helper requests FILE_WRITE_DATA only.
        file_id = alice.createFile(
            tree,
            "\\" + filename,
            desiredAccess=FILE_WRITE_DATA | FILE_APPEND_DATA | SYNCHRONIZE,
            shareMode=FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            creationOption=FILE_NON_DIRECTORY_FILE,
            creationDisposition=FILE_CREATE,
        )
        try:
            alice.writeFile(tree, file_id, b"synthetic SMB POC write test\r\n")
        finally:
            alice.closeFile(tree, file_id)

        alice.createDirectory("alpha", "\\" + dirname)
        alice.rename("alpha", "\\" + dirname, "\\" + renamed_dir)
        alice.deleteDirectory("alpha", "\\" + renamed_dir)
        alice.deleteFile("alpha", "\\" + filename)
        alice.connectTree("beta")
        print("PASS alice alpha write/create/rename/delete and beta access")
    finally:
        alice.logoff()

    bob = connect("bob", bob_password)
    try:
        entries = bob.listPath("alpha", "\\*")
        assert any(entry.get_longname() == "poc-readme.txt" for entry in entries)
        received = []
        bob.getFile("alpha", "\\poc-readme.txt", received.append)
        assert b"".join(received) == b"Synthetic SMB POC data.\r\n"
        print("PASS bob alpha list/read")

        bob_tree = bob.connectTree("alpha")
        denied(
            "bob alpha write",
            lambda: bob.createFile(
                bob_tree,
                "\\poc-bob-denied-" + nonce + ".txt",
                desiredAccess=FILE_WRITE_DATA | FILE_APPEND_DATA | SYNCHRONIZE,
                shareMode=FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                creationOption=FILE_NON_DIRECTORY_FILE,
                creationDisposition=FILE_CREATE,
            ),
        )
        denied("bob beta access", lambda: bob.connectTree("beta"))
    finally:
        bob.logoff()

    anonymous = SMBConnection(
        HOST, HOST, sess_port=PORT, timeout=8, preferredDialect=SMB2_DIALECT_311
    )
    denied("anonymous login", lambda: anonymous.login("", ""))
    anonymous.close()
    print("PASS all Impacket protocol smoke checks")


if __name__ == "__main__":
    main()
