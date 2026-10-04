# Inject the stable N-API status napi_generic_failure at the host boundary.
# No allocation pressure, application mutation, or production export is needed.
set language rust
set debuginfod enabled off
set auto-load off
set pagination off
set confirm off
set breakpoint pending on
set disable-randomization off
break napi_create_function
commands
  silent
  return 9 as i32
  continue
end
run
