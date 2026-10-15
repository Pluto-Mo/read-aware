// Folder imports on iOS: pick a folder, list the importable books below it.
//
// tauri-plugin-dialog cannot pick folders on iOS, so this bridge presents a
// folder UIDocumentPickerViewController itself. The picked folder stays in
// place (no copy): its security-scoped access is held while the books are
// imported straight from their paths, and `ra_folder_pick_release` (the
// `book_folder_release` command) gives it back once the imports are done.
//
// Called from Rust (src/book_folders.rs) over plain C FFI. A load-time
// constructor hands the entry points over, since release builds strip the
// export table a runtime symbol lookup would need (see StatusBarBridge.m).
// The outcome is parked as JSON and collected by polling, like the Android
// pickers: {"generation","status":"picked"|"cancelled"|"error","error"?,
// "rootName"?,"files"?:[{"path","relativePath","size"}],"truncated"?}.

#import <UIKit/UIKit.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#include <stdlib.h>
#include <string.h>

// Mirror MAX_FOLDER_BOOKS / MAX_FOLDER_DEPTH in book_folders.rs.
static const NSUInteger RAFolderMaxBooks = 5000;
static const NSUInteger RAFolderMaxDepth = 32;

static NSObject *raFolderPickLock;
static NSString *raFolderPickResult;
// The picked folder whose security-scoped access is held until release.
static NSURL *raFolderPickScope;

static void ra_park(NSDictionary *outcome) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:outcome options:0 error:nil];
  NSString *json = data ? [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] : nil;
  if (json == nil) {
    json = [NSString stringWithFormat:@"{\"generation\":%@,\"status\":\"error\",\"error\":\"unencodable folder listing\"}",
                                      outcome[@"generation"] ?: @0];
  }
  @synchronized(raFolderPickLock) {
    raFolderPickResult = json;
  }
}

static void ra_end_scope(void) {
  @synchronized(raFolderPickLock) {
    [raFolderPickScope stopAccessingSecurityScopedResource];
    raFolderPickScope = nil;
  }
}

// Mirror `is_book_path` in external_open.rs: the real book formats.
static BOOL ra_is_book_name(NSString *name) {
  static NSArray<NSString *> *suffixes;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    suffixes = @[ @".epub", @".mobi", @".prc", @".azw3", @".azw", @".kf8", @".fb2", @".fb2.zip", @".fbz",
                  @".cbz", @".cbr", @".txt", @".text", @".html", @".htm", @".xhtml", @".pdf" ];
  });
  NSString *lower = name.lowercaseString;
  for (NSString *suffix in suffixes) {
    if ([lower hasSuffix:suffix]) return YES;
  }
  return NO;
}

// Every importable book below `root`, without following symlinks or entering
// hidden folders, `__MACOSX` or package bundles; truncated past the limit.
static NSDictionary *ra_walk(NSURL *root, int generation) {
  NSArray<NSURLResourceKey> *keys =
      @[ NSURLIsDirectoryKey, NSURLIsRegularFileKey, NSURLIsSymbolicLinkKey, NSURLFileSizeKey ];
  NSDirectoryEnumerator<NSURL *> *walker = [NSFileManager.defaultManager
                 enumeratorAtURL:root
      includingPropertiesForKeys:keys
                         options:NSDirectoryEnumerationSkipsHiddenFiles |
                                 NSDirectoryEnumerationSkipsPackageDescendants
                    errorHandler:^BOOL(NSURL *url, NSError *error) {
                      // An unreadable subfolder costs only its own books.
                      NSLog(@"Folder import skipped %@: %@", url.path, error);
                      return YES;
                    }];
  NSArray<NSString *> *rootParts = root.URLByStandardizingPath.pathComponents;
  NSMutableArray *files = [NSMutableArray array];
  BOOL truncated = NO;
  for (NSURL *url in walker) {
    NSDictionary<NSURLResourceKey, id> *values = [url resourceValuesForKeys:keys error:nil];
    if ([values[NSURLIsSymbolicLinkKey] boolValue]) continue;
    NSString *name = url.lastPathComponent;
    if ([values[NSURLIsDirectoryKey] boolValue]) {
      if ([name isEqualToString:@"__MACOSX"] || walker.level >= RAFolderMaxDepth) [walker skipDescendants];
      continue;
    }
    if (![values[NSURLIsRegularFileKey] boolValue] || !ra_is_book_name(name)) continue;
    if (files.count == RAFolderMaxBooks) {
      truncated = YES;
      break;
    }
    NSArray<NSString *> *parts = url.URLByStandardizingPath.pathComponents;
    if (parts.count <= rootParts.count) continue;
    NSString *relative =
        [[parts subarrayWithRange:NSMakeRange(rootParts.count, parts.count - rootParts.count)]
            componentsJoinedByString:@"/"];
    NSNumber *size = values[NSURLFileSizeKey] ?: @(-1);
    [files addObject:@{@"path" : url.path, @"relativePath" : relative, @"size" : size}];
  }
  return @{
    @"generation" : @(generation),
    @"status" : @"picked",
    @"rootName" : root.lastPathComponent ?: @"",
    @"files" : files,
    @"truncated" : @(truncated),
  };
}

@interface RAFolderPickDelegate : NSObject <UIDocumentPickerDelegate>
@property(nonatomic) int generation;
@end

@implementation RAFolderPickDelegate
- (void)documentPicker:(UIDocumentPickerViewController *)controller
    didPickDocumentsAtURLs:(NSArray<NSURL *> *)urls {
  int generation = self.generation;
  NSURL *root = urls.firstObject;
  if (root == nil) {
    ra_park(@{@"generation" : @(generation), @"status" : @"cancelled"});
    return;
  }
  ra_end_scope();
  if ([root startAccessingSecurityScopedResource]) {
    @synchronized(raFolderPickLock) {
      raFolderPickScope = root;
    }
  }
  // A big library is thousands of stat calls: never on the main queue.
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    ra_park(ra_walk(root, generation));
  });
}

- (void)documentPickerWasCancelled:(UIDocumentPickerViewController *)controller {
  ra_park(@{@"generation" : @(self.generation), @"status" : @"cancelled"});
}
@end

static RAFolderPickDelegate *raFolderPickDelegate;

static UIViewController *ra_presenting_controller(void) {
  for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
    if (![scene isKindOfClass:[UIWindowScene class]]) continue;
    for (UIWindow *window in ((UIWindowScene *)scene).windows) {
      if (!window.isKeyWindow) continue;
      UIViewController *controller = window.rootViewController;
      while (controller.presentedViewController != nil) controller = controller.presentedViewController;
      return controller;
    }
  }
  return nil;
}

static void ra_folder_pick_start(int32_t generation) {
  @synchronized(raFolderPickLock) {
    raFolderPickResult = nil;
  }
  dispatch_async(dispatch_get_main_queue(), ^{
    UIViewController *presenter = ra_presenting_controller();
    if (presenter == nil) {
      ra_park(@{@"generation" : @(generation), @"status" : @"error", @"error" : @"no window to present from"});
      return;
    }
    if (raFolderPickDelegate == nil) raFolderPickDelegate = [RAFolderPickDelegate new];
    raFolderPickDelegate.generation = generation;
    UIDocumentPickerViewController *picker =
        [[UIDocumentPickerViewController alloc] initForOpeningContentTypes:@[ UTTypeFolder ] asCopy:NO];
    picker.delegate = raFolderPickDelegate;
    picker.allowsMultipleSelection = NO;
    [presenter presentViewController:picker animated:YES completion:nil];
  });
}

// The parked JSON as a `strdup` copy the Rust side frees, or NULL.
static char *ra_folder_pick_take(void) {
  NSString *result;
  @synchronized(raFolderPickLock) {
    result = raFolderPickResult;
    raFolderPickResult = nil;
  }
  return result ? strdup(result.UTF8String) : NULL;
}

static void ra_folder_pick_release(void) { ra_end_scope(); }

// Defined in the Rust crate (src/book_folders.rs); resolved when the app links libapp.a.
extern void ra_register_folder_pick_bridge(void (*start)(int32_t), char *(*take)(void), void (*release)(void));

__attribute__((constructor)) static void ra_install_folder_pick_bridge(void) {
  raFolderPickLock = [NSObject new];
  ra_register_folder_pick_bridge(ra_folder_pick_start, ra_folder_pick_take, ra_folder_pick_release);
}
