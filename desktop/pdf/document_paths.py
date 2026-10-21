"""Ordinary drive and UNC paths, shared by the isolated PDF workers."""
import ntpath
import os
import re


def document_path(value, windows=None):
    if not isinstance(value, str) or not 0 < len(value) < 32760 or re.search(r"[\x00-\x1f]", value):
        raise ValueError("Choose a valid file or folder path.")
    if windows is None:
        windows = os.name == "nt"
    if not windows:
        if not os.path.isabs(value):
            raise ValueError("Choose an absolute file or folder path.")
        return value
    value = value.replace("/", "\\")
    if value.lower().startswith("\\\\?\\unc\\"):
        value = "\\\\" + value[8:]
    elif re.match(r"^\\\\\?\\[a-z]:\\", value, re.I):
        value = value[4:]
    drive = bool(re.match(r"^[a-z]:\\", value, re.I))
    unc = bool(re.match(r"^\\\\[^\\]+\\[^\\]+(?:\\|$)", value)) and not value.startswith(("\\\\?\\", "\\\\.\\"))
    if not drive and not unc:
        raise ValueError("Choose an absolute drive path or a network share. Device paths are not document files.")
    tail = value[3:] if drive else value[2:]
    if re.search(r'[<>:"|?*]', tail):
        raise ValueError("Alternate streams, wildcards and device paths are not document files.")
    pieces = tail.split("\\")
    if any(re.match(r"^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$|clock\$)(?:\.|$)", p, re.I) for p in pieces) or (unc and pieces[1].upper() in ("IPC$", "PIPE")):
        raise ValueError("Device names and named pipes are not document files.")
    return ntpath.normpath(value)
