# Inject the stable N-API status napi_generic_failure at the host boundary.
# No allocation pressure, application mutation, or production export is needed.
set language c
set debuginfod enabled off
set auto-load off
set pagination off
set confirm off
set breakpoint pending on
set disable-randomization off
break napi_create_function
commands
  silent
  return (int)9
  continue
end
run
