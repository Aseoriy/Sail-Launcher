/* Kernel-observed Wine main image, measured by the surviving supervisor.
 * This is process activity, not a rendered-frame or successful-gameplay signal.
 * No PID discovered here is ever signaled: Stop retains the subreaper waiters. */
#include <dirent.h>
#include <sys/sysmacros.h>
#include <strings.h>
#define GAME_METHOD "pe-image-v1"
struct game_process { pid_t pid, parent; uint64_t ticks; int descendant; };
static char *game_image, *game_prefix, *game_proton;
static int game_wine;
static uint64_t game_dev, game_ino, game_size, game_mtime;
static int game_fd = -1, game_confirmed, game_error;
static uint64_t game_elapsed, game_start_offset, game_last_sample;
static size_t game_active;
static struct stat wine_images[24];
static int wine_loader_fds[24];
static size_t wine_image_count;
static struct game_process prior_games[MAX_CHILDREN];
static size_t prior_game_count;

static int game_validate_file(void) {
    struct stat s;
    if (fstat(game_fd, &s)) return -1;
    uint64_t mt = (uint64_t)s.st_mtim.tv_sec * 1000 + ((uint64_t)s.st_mtim.tv_nsec + 500000) / 1000000;
    if (!S_ISREG(s.st_mode) || (uint64_t)s.st_dev != game_dev || (uint64_t)s.st_ino != game_ino
        || (uint64_t)s.st_size != game_size || mt != game_mtime) { errno = ESTALE; return -1; }
    return 0;
}
static int game_config(char **f, size_t count) {
    if (count < 8) return -1;
    game_wine = !strcmp(f[0], "SAIL_WINE_IMAGE_1");
    if ((!game_wine && (strcmp(f[0], "SAIL_GAME_IMAGE_1") || count != 8)) || decimal(f[2], &game_dev) || decimal(f[3], &game_ino)
        || decimal(f[4], &game_size) || decimal(f[5], &game_mtime)) return -1;
    game_image = f[1]; game_prefix = f[6]; game_proton = f[7];
    if (game_prefix[0] != '/' || game_proton[0] != '/' || strlen(game_image) >= PATH_MAX
        || strlen(game_prefix) >= PATH_MAX || strlen(game_proton) >= PATH_MAX) return -1;
    game_fd = canonical_open(game_image, O_RDONLY);
    if (game_fd < 0 || game_validate_file()) return -1;
    if (game_wine) {
        uint64_t loaders;
        if (count < 9 || decimal(f[8], &loaders) || !loaders || loaders > 24 || count != 9 + loaders * 5) return -1;
        for (size_t i = 0; i < loaders; i++) {
            char **item = f + 9 + i * 5;
            uint64_t dev, ino, size, mtime;
            if (decimal(item[1], &dev) || decimal(item[2], &ino) || decimal(item[3], &size) || decimal(item[4], &mtime)) return -1;
            int fd = canonical_open(item[0], O_RDONLY);
            struct stat st;
            if (fd < 0 || fstat(fd, &st) || !S_ISREG(st.st_mode) || !(st.st_mode & 0111)
                || (uint64_t)st.st_dev != dev || (uint64_t)st.st_ino != ino || (uint64_t)st.st_size != size
                || (uint64_t)st.st_mtim.tv_sec * 1000 + ((uint64_t)st.st_mtim.tv_nsec + 500000) / 1000000 != mtime) { if (fd >= 0) close(fd); errno = ESTALE; return -1; }
            wine_images[wine_image_count] = st; wine_loader_fds[wine_image_count++] = fd;
        }
        return 0;
    }
    /* Wine 11 moved the loaders beneath lib/wine. Match the selected
     * runtime's file identities in both layouts, never names alone. */
    const char *names[] = {"bin/wine64-preloader", "bin/wine-preloader", "bin/wine64", "bin/wine",
        "lib/wine/x86_64-unix/wine64-preloader", "lib/wine/x86_64-unix/wine-preloader",
        "lib/wine/x86_64-unix/wine64", "lib/wine/x86_64-unix/wine",
        "lib/wine/i386-unix/wine64-preloader", "lib/wine/i386-unix/wine-preloader",
        "lib/wine/i386-unix/wine64", "lib/wine/i386-unix/wine"};
    for (size_t i = 0; i < sizeof(names)/sizeof(names[0]); i++) {
        char name[PATH_MAX];
        int n = snprintf(name, sizeof(name), "%s/files/%s", game_proton, names[i]);
        if (n <= 0 || (size_t)n >= sizeof(name)) return -1;
        if (!stat(name, &wine_images[wine_image_count]) && S_ISREG(wine_images[wine_image_count].st_mode)) wine_image_count++;
    }
    return wine_image_count ? 0 : -1;
}
static int game_proc_stat(int dir, struct game_process *p) {
    char s[4096]; int fd = openat(dir, "stat", O_RDONLY | O_CLOEXEC);
    if (fd < 0) return -1;
    ssize_t n = read(fd, s, sizeof(s)-1); close(fd);
    if (n <= 0 || (size_t)n == sizeof(s)-1) return -1;
    s[n] = 0; char *c = strrchr(s, ')'); if (!c) return -1; c += 2;
    if (*c == 'Z' || *c == 'X') { errno = ESRCH; return -1; }
    c = strchr(c, ' '); if (!c) return -1;
    char *end; long parent = strtol(c+1, &end, 10);
    if (end == c+1 || parent < 0 || parent > INT_MAX) return -1;
    p->parent = (pid_t)parent;
    c = end+1;
    for (int field = 5; field < 22; field++) { c = strchr(c, ' '); if (!c) return -1; c++; }
    p->ticks = strtoull(c, &end, 10); return end == c ? -1 : 0;
}
static ssize_t game_proc_bytes(int dir, const char *name, char *s, size_t size) {
    int fd = openat(dir, name, O_RDONLY | O_CLOEXEC); if (fd < 0) return -1;
    ssize_t n = read(fd, s, size-1); int saved = errno; close(fd); errno = saved;
    if (n < 0 || (size_t)n == size-1) { if (n >= 0) errno = EOVERFLOW; return -1; }
    s[n] = 0; return n;
}
static int game_match(int dir, int *exact) {
    struct stat exe;
    if (fstatat(dir, "exe", &exe, 0)) return -1;
    int wine = 0;
    for (size_t i = 0; i < wine_image_count; i++) if (exe.st_dev == wine_images[i].st_dev && exe.st_ino == wine_images[i].st_ino) wine = 1;
    if (!wine) return 0;
    char env[131072], cmd[32768];
    ssize_t n = game_proc_bytes(dir, "environ", env, sizeof(env)); if (n < 0) return -1;
    int prefix = 0;
    for (ssize_t i = 0; i < n;) {
        size_t len = strnlen(env+i, (size_t)(n-i));
        if (len == (size_t)(n-i)) { errno = EPROTO; return -1; }
        if (game_wine ? !strncmp(env+i, "WINEPREFIX=", 11) && !strcmp(env+i+11, game_prefix)
            : !strncmp(env+i, "STEAM_COMPAT_DATA_PATH=", 23) && !strcmp(env+i+23, game_prefix)) prefix = 1;
        i += (ssize_t)len+1;
    }
    if (!prefix) return 0;
    n = game_proc_bytes(dir, "cmdline", cmd, sizeof(cmd)); if (n < 0) return -1;
    size_t length = strnlen(cmd, (size_t)n);
    while (length && cmd[length-1] == ' ') cmd[--length] = 0;
    char *base = cmd;
    for (char *c = cmd; *c; c++) if (*c == '/' || *c == '\\') base = c+1;
    if (strlen(base) < 5 || strcasecmp(base+strlen(base)-4, ".exe")) return 0;
    int fd = openat(dir, "maps", O_RDONLY | O_CLOEXEC); if (fd < 0) return -1;
    FILE *maps = fdopen(fd, "r"); if (!maps) { close(fd); return -1; }
    char line[PATH_MAX+256]; size_t lines = 0; int result = 0;
    while (fgets(line, sizeof(line), maps)) {
        if (++lines > 32768 || !strchr(line, '\n')) { errno = EOVERFLOW; result = -1; break; }
        unsigned long long lo, hi, offset, ino; unsigned int maj, min; char perms[5]; int used = 0;
        if (sscanf(line, "%llx-%llx %4s %llx %x:%x %llu %n", &lo,&hi,perms,&offset,&maj,&min,&ino,&used) != 7) { errno = EPROTO; result = -1; break; }
        if (offset || !ino || perms[0] != 'r' || perms[3] != 'p') continue;
        char *name = line+used; name[strcspn(name,"\n")] = 0;
        char *mapped_base = strrchr(name,'/'); if (!mapped_base || strcasecmp(mapped_base+1,base)) continue;
        uint64_t dev = (uint64_t)makedev(maj,min);
        if (dev == game_dev && ino == game_ino) { *exact = 1; result = 1; break; }
        /* After exact target confirmation, include main PE images from its
         * install directory in this owned session and prefix. Never runtime,
         * registry, wineboot, or another prefix's maintenance processes. */
        size_t root_len = (size_t)(strrchr(game_image,'/')-game_image)+1;
        if (root_len<=1 || strncmp(name,game_image,root_len) || (!strncmp(name,game_proton,strlen(game_proton)) && name[strlen(game_proton)]=='/')) continue;
        struct stat file; unsigned char header[64], pe[24];
        int image = canonical_open(name,O_RDONLY); if (image < 0) continue;
        ssize_t count = pread(image,header,sizeof(header),0);
        uint32_t pe_offset = count == sizeof(header) ? (uint32_t)header[60] | (uint32_t)header[61]<<8 | (uint32_t)header[62]<<16 | (uint32_t)header[63]<<24 : 0;
        if (!fstat(image,&file) && (uint64_t)file.st_dev == dev && (uint64_t)file.st_ino == ino
            && count == sizeof(header) && header[0]=='M' && header[1]=='Z' && pe_offset>=64 && pe_offset<=16777216
            && pread(image,pe,sizeof(pe),pe_offset)==sizeof(pe) && pe[0]=='P' && pe[1]=='E' && !pe[2] && !pe[3]
            && (pe[22]&2) && !(pe[23]&0x20)) result = 1;
        close(image); if (result) break;
    }
    if (ferror(maps)) { errno = EIO; result = -1; }
    int saved = errno; fclose(maps); errno = saved; return result;
}
static int game_pid_compare(const void *a, const void *b) {
    pid_t x=((const struct game_process *)a)->pid, y=((const struct game_process *)b)->pid;
    return (x>y)-(x<y);
}
static struct game_process *game_find(struct game_process *all, size_t count, pid_t pid) {
    struct game_process key={.pid=pid};
    return bsearch(&key,all,count,sizeof(*all),game_pid_compare);
}
static int game_ancestry(struct game_process *all, size_t count, struct game_process p, int verify) {
    for (size_t depth=0; depth<128; depth++) {
        if (p.parent==getpid()) return 1;
        struct game_process *parent=game_find(all,count,p.parent);
        if (!parent || parent->pid==p.pid) return 0;
        if (verify) {
            char name[64]; snprintf(name,sizeof(name),"/proc/%d",parent->pid);
            int dir=open(name,O_RDONLY|O_DIRECTORY|O_CLOEXEC); if (dir<0) return 0;
            struct game_process actual={0}; int ok=!game_proc_stat(dir,&actual)
                && actual.ticks==parent->ticks && actual.parent==parent->parent;
            close(dir); if (!ok) return 0;
        }
        p=*parent;
    }
    return 0;
}
static void game_observe(uint64_t now) {
    if (!game_image || !exec_succeeded || game_error || tracking_error) { game_active = 0; return; }
    if (game_last_sample && now-game_last_sample < 100) return;
    if (game_validate_file()) { game_error = errno; game_active = 0; return; }
    if (game_wine) for (size_t i = 0; i < wine_image_count; i++) {
        struct stat st;
        if (fstat(wine_loader_fds[i], &st) || st.st_size != wine_images[i].st_size
            || st.st_mtim.tv_sec != wine_images[i].st_mtim.tv_sec || st.st_mtim.tv_nsec != wine_images[i].st_mtim.tv_nsec
            || st.st_ctim.tv_sec != wine_images[i].st_ctim.tv_sec || st.st_ctim.tv_nsec != wine_images[i].st_ctim.tv_nsec) {
            game_error = ESTALE; game_active = 0; return;
        }
    }
    /* Stat census establishes ancestry only. Image inspection is restricted to
     * descendants of this supervisor. Numeric PIDs are pinned during sampling. */
    struct game_process all[MAX_CHILDREN], current[MAX_CHILDREN]; size_t count = 0, active = 0;
    DIR *proc = opendir("/proc"); if (!proc) { game_error = errno; game_active = 0; return; }
    struct dirent *entry;
    while ((entry = readdir(proc))) {
        if (!*entry->d_name || strspn(entry->d_name,"0123456789") != strlen(entry->d_name)) continue;
        if (count == MAX_CHILDREN) { game_error = EOVERFLOW; break; }
        int dir = openat(dirfd(proc), entry->d_name, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
        if (dir < 0) continue;
        struct game_process p = {.pid=(pid_t)atoi(entry->d_name)};
        if (!game_proc_stat(dir,&p)) all[count++] = p;
        close(dir);
    }
    closedir(proc);
    qsort(all,count,sizeof(*all),game_pid_compare);
    for (size_t i=0; i<count; i++) if (all[i].pid!=getpid()) all[i].descendant=game_ancestry(all,count,all[i],0);
    int exact = 0;
    for (size_t i=0; !game_error && i<count; i++) if (all[i].descendant) {
        int handle = pidfd_open_owned(all[i].pid); if (handle < 0) { if (errno!=ESRCH) game_error=errno; continue; }
        char name[64]; snprintf(name,sizeof(name),"/proc/%d",all[i].pid);
        int dir = open(name,O_RDONLY|O_DIRECTORY|O_CLOEXEC);
        struct game_process before={0}, after={0}; int matched=0, found=0;
        if (dir>=0 && !game_proc_stat(dir,&before) && before.ticks==all[i].ticks && before.parent==all[i].parent) {
            matched=game_match(dir,&found);
            if (matched<0 && errno!=ENOENT && errno!=ESRCH) game_error=errno;
            struct pollfd alive={.fd=handle,.events=POLLIN};
            if (matched>0 && !game_proc_stat(dir,&after) && after.ticks==before.ticks && after.parent==before.parent && poll(&alive,1,0)==0 && game_ancestry(all,count,all[i],1)) {
                current[active++]=all[i]; if (found) exact=1;
            }
        }
        if (dir>=0) close(dir);
        close(handle);
    }
    if (game_error) { game_active=0; return; }
    if (!game_confirmed && exact) { game_confirmed=1; game_start_offset=now-began_ms; }
    int overlap=0;
    for (size_t i=0; i<active && !overlap; i++) for (size_t j=0; j<prior_game_count; j++)
        if (current[i].pid==prior_games[j].pid && current[i].ticks==prior_games[j].ticks) { overlap=1; break; }
    if (game_confirmed && overlap && game_last_sample) game_elapsed+=now-game_last_sample;
    game_active=game_confirmed ? active : 0;
    memcpy(prior_games,current,active*sizeof(*current)); prior_game_count=game_confirmed ? active : 0; game_last_sample=now;
}
