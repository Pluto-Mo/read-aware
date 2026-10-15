use super::*;
use std::fs;

fn touch(root: &Path, relative: &str, bytes: &[u8]) {
    let path = root.join(relative);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}

fn relative_paths(scan: &FolderScan) -> Vec<&str> {
    scan.files
        .iter()
        .map(|file| file.relative_path.as_str())
        .collect()
}

#[test]
fn scan_lists_nested_books_relative_to_the_picked_folder() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("Library");
    touch(&root, "Dune.epub", b"12345");
    touch(&root, "Sci-fi/Asimov/Foundation.mobi", b"1");
    touch(&root, "Sci-fi/three-body.fb2.zip", b"1");
    touch(&root, "Comics/Saga.cbz", b"1");
    touch(&root, "Notes/novel.TXT", b"1");

    let scan = scan_folder(&root).unwrap();

    assert_eq!(scan.root_name, "Library");
    assert!(!scan.truncated);
    assert_eq!(
        relative_paths(&scan),
        [
            "Comics/Saga.cbz",
            "Dune.epub",
            "Notes/novel.TXT",
            "Sci-fi/Asimov/Foundation.mobi",
            "Sci-fi/three-body.fb2.zip",
        ]
    );
    let dune = scan
        .files
        .iter()
        .find(|file| file.relative_path == "Dune.epub")
        .unwrap();
    assert_eq!(dune.size, 5);
    assert_eq!(Path::new(&dune.path), root.join("Dune.epub"));
}

#[test]
fn scan_skips_non_books_hidden_entries_and_archive_debris() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    touch(root, "cover.jpg", b"1");
    touch(root, "archive.zip", b"1");
    touch(root, ".hidden.epub", b"1");
    touch(root, "._Dune.epub", b"1");
    touch(root, ".git/objects/book.epub", b"1");
    touch(root, "__MACOSX/Dune.epub", b"1");
    touch(root, "Dune.epub", b"1");

    assert_eq!(relative_paths(&scan_folder(root).unwrap()), ["Dune.epub"]);
}

#[cfg(unix)]
#[test]
fn scan_does_not_follow_symlinks() {
    let dir = tempfile::tempdir().unwrap();
    let outside = dir.path().join("outside");
    touch(&outside, "Elsewhere.epub", b"1");
    let root = dir.path().join("picked");
    touch(&root, "Here.epub", b"1");
    std::os::unix::fs::symlink(&outside, root.join("linked-folder")).unwrap();
    std::os::unix::fs::symlink(outside.join("Elsewhere.epub"), root.join("linked.epub")).unwrap();
    // A link back to the root would loop forever if followed.
    std::os::unix::fs::symlink(&root, root.join("loop")).unwrap();

    assert_eq!(relative_paths(&scan_folder(&root).unwrap()), ["Here.epub"]);
}

#[test]
fn scan_stops_at_the_depth_limit() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    let deepest_kept = vec!["d"; MAX_FOLDER_DEPTH - 1].join("/");
    let too_deep = vec!["d"; MAX_FOLDER_DEPTH].join("/");
    touch(root, &format!("{deepest_kept}/kept.epub"), b"1");
    touch(root, &format!("{too_deep}/lost.epub"), b"1");

    let scan = scan_folder(root).unwrap();
    assert_eq!(
        relative_paths(&scan),
        [format!("{deepest_kept}/kept.epub").as_str()]
    );
}

#[test]
fn scan_reports_a_folder_with_more_books_than_the_limit() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path();
    for index in 0..MAX_FOLDER_BOOKS {
        touch(root, &format!("book-{index:05}.txt"), b"");
    }
    let exact = scan_folder(root).unwrap();
    assert!(!exact.truncated);
    assert_eq!(exact.files.len(), MAX_FOLDER_BOOKS);

    touch(root, "one-more.txt", b"");
    let over = scan_folder(root).unwrap();
    assert!(over.truncated);
    assert_eq!(over.files.len(), MAX_FOLDER_BOOKS);
}

#[test]
fn scan_rejects_a_missing_folder_or_a_file() {
    let dir = tempfile::tempdir().unwrap();
    touch(dir.path(), "Dune.epub", b"1");
    assert!(scan_folder(&dir.path().join("missing")).is_err());
    assert!(scan_folder(&dir.path().join("Dune.epub")).is_err());
}
