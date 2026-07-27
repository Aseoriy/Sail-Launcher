create index if not exists items_author_id_idx
  on public.items (author_id);

create index if not exists launcher_libraries_user_id_idx
  on public.launcher_libraries (user_id);

create index if not exists launcher_presets_user_id_idx
  on public.launcher_presets (user_id);

create index if not exists sync_policies_user_id_idx
  on public.sync_policies (user_id);

create index if not exists sync_artifacts_user_id_idx
  on public.sync_artifacts (user_id);

create index if not exists sync_artifacts_library_id_idx
  on public.sync_artifacts (library_id);

create index if not exists sync_runs_profile_id_idx
  on public.sync_runs (profile_id);

create index if not exists sync_runs_artifact_id_idx
  on public.sync_runs (artifact_id);

create index if not exists oauth_states_user_id_idx
  on public.oauth_states (user_id);
