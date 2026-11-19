-- 0582: merge_clients has been executable by every role since 0190 (a function's default is PUBLIC), including the
-- hosted anonymous role. It refuses anyone not signed in (app.can_touch_client), so nothing leaked, but a security
-- definer function should not be reachable by the public at all. Only the app role may call it, like the others.
revoke execute on function public.merge_clients(uuid, uuid) from public;
grant execute on function public.merge_clients(uuid, uuid) to isaac_app;
