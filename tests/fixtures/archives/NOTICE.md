# Archive Test Fixtures

The following tiny RAR fixtures are from libarchive's upstream test suite:

- https://raw.githubusercontent.com/libarchive/libarchive/master/libarchive/test/test_read_format_rar.rar.uu
- https://raw.githubusercontent.com/libarchive/libarchive/master/libarchive/test/test_read_format_rar5_stored.rar.uu

The first fixture includes a symbolic link and intentionally tests rejection of unsafe link entries. The second contains `helloworld.txt` with the text `hello libarchive test suite!`.

libarchive is BSD licensed: https://github.com/libarchive/libarchive/blob/master/COPYING

These fixtures are used only in tests and are not included in the application distribution.
