/**
 * Shell completion commands
 */

import { getLogger } from '../logger.ts';

/**
 * Generate bash completion script
 */
function generateBashCompletion(): string {
  return `# c8ctl bash completion
_c8ctl_completions() {
  local cur prev words cword
  
  # Initialize completion variables (standalone, no bash-completion dependency)
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  words=("\${COMP_WORDS[@]}")
  cword=\${COMP_CWORD}

  # Commands (verbs)
  local verbs="list search get create cancel await complete fail activate resolve publish correlate deploy run watch add remove rm load unload sync upgrade downgrade init use output completion help"
  
  # Resources by verb
  local list_resources="process-instances process-instance pi user-tasks user-task ut incidents incident inc jobs profiles profile plugins plugin"
  local search_resources="process-instances process-instance pi process-definitions process-definition pd user-tasks user-task ut incidents incident inc jobs variables variable"
  local get_resources="process-instance pi process-definition pd incident inc topology form"
  local create_resources="process-instance pi"
  local cancel_resources="process-instance pi"
  local await_resources="process-instance pi"
  local complete_resources="user-task ut job"
  local fail_resources="job"
  local activate_resources="jobs"
  local resolve_resources="incident inc"
  local publish_resources="message msg"
  local correlate_resources="message msg"
  local add_resources="profile"
  local remove_resources="profile"
  local load_resources="plugin"
  local unload_resources="plugin"
  local sync_resources="plugin plugins"
  local upgrade_resources="plugin"
  local downgrade_resources="plugin"
  local init_resources="plugin"
  local use_resources="profile tenant"
  local output_resources="json text"
  local completion_resources="bash zsh fish"
  local help_resources="list get create complete await search deploy run watch cancel resolve fail activate publish correlate upgrade downgrade init plugin"

  # Global flags
  local flags="--help --version --profile --from --all --bpmnProcessId --id --processInstanceKey --processDefinitionKey --parentProcessInstanceKey --variables --state --assignee --type --correlationKey --timeToLive --maxJobsToActivate --timeout --worker --retries --errorMessage --baseUrl --clientId --clientSecret --audience --oAuthUrl --defaultTenantId --awaitCompletion --fetchVariables --requestTimeout --name --key --elementId --errorType --value --scopeKey --fullValue --userTask --ut --processDefinition --pd --iname --iid --iassignee --ierrorMessage --itype --ivalue"

  case \${cword} in
    1)
      # Complete verbs
      COMPREPLY=( \$(compgen -W "\${verbs}" -- "\${cur}") )
      ;;
    2)
      # Complete resources based on verb
      local verb="\${words[1]}"
      case "\${verb}" in
        list)
          COMPREPLY=( \$(compgen -W "\${list_resources}" -- "\${cur}") )
          ;;
        search)
          COMPREPLY=( \$(compgen -W "\${search_resources}" -- "\${cur}") )
          ;;
        get)
          COMPREPLY=( \$(compgen -W "\${get_resources}" -- "\${cur}") )
          ;;
        create)
          COMPREPLY=( \$(compgen -W "\${create_resources}" -- "\${cur}") )
          ;;
        cancel)
          COMPREPLY=( \$(compgen -W "\${cancel_resources}" -- "\${cur}") )
          ;;
        await)
          COMPREPLY=( \$(compgen -W "\${await_resources}" -- "\${cur}") )
          ;;
        complete)
          COMPREPLY=( \$(compgen -W "\${complete_resources}" -- "\${cur}") )
          ;;
        fail)
          COMPREPLY=( \$(compgen -W "\${fail_resources}" -- "\${cur}") )
          ;;
        activate)
          COMPREPLY=( \$(compgen -W "\${activate_resources}" -- "\${cur}") )
          ;;
        resolve)
          COMPREPLY=( \$(compgen -W "\${resolve_resources}" -- "\${cur}") )
          ;;
        publish)
          COMPREPLY=( \$(compgen -W "\${publish_resources}" -- "\${cur}") )
          ;;
        correlate)
          COMPREPLY=( \$(compgen -W "\${correlate_resources}" -- "\${cur}") )
          ;;
        add)
          COMPREPLY=( \$(compgen -W "\${add_resources}" -- "\${cur}") )
          ;;
        remove|rm)
          COMPREPLY=( \$(compgen -W "\${remove_resources}" -- "\${cur}") )
          ;;
        load)
          COMPREPLY=( \$(compgen -W "\${load_resources}" -- "\${cur}") )
          ;;
        unload)
          COMPREPLY=( \$(compgen -W "\${unload_resources}" -- "\${cur}") )
          ;;
        sync)
          COMPREPLY=( \$(compgen -W "\${sync_resources}" -- "\${cur}") )
          ;;
        upgrade)
          COMPREPLY=( \$(compgen -W "\${upgrade_resources}" -- "\${cur}") )
          ;;
        downgrade)
          COMPREPLY=( \$(compgen -W "\${downgrade_resources}" -- "\${cur}") )
          ;;
        init)
          COMPREPLY=( \$(compgen -W "\${init_resources}" -- "\${cur}") )
          ;;
        use)
          COMPREPLY=( \$(compgen -W "\${use_resources}" -- "\${cur}") )
          ;;
        output)
          COMPREPLY=( \$(compgen -W "\${output_resources}" -- "\${cur}") )
          ;;
        completion)
          COMPREPLY=( \$(compgen -W "\${completion_resources}" -- "\${cur}") )
          ;;
        help)
          COMPREPLY=( \$(compgen -W "\${help_resources}" -- "\${cur}") )
          ;;
        deploy|run|watch)
          # Complete with files
          COMPREPLY=( \$(compgen -f -- "\${cur}") )
          ;;
      esac
      ;;
    *)
      # Complete flags or files
      if [[ \${cur} == -* ]]; then
        COMPREPLY=( \$(compgen -W "\${flags}" -- "\${cur}") )
      else
        COMPREPLY=( \$(compgen -f -- "\${cur}") )
      fi
      ;;
  esac
}

complete -F _c8ctl_completions c8ctl
complete -F _c8ctl_completions c8
`;
}

/**
 * Generate zsh completion script
 */
function generateZshCompletion(): string {
  return `#compdef c8ctl c8

_c8ctl() {
  local -a verbs resources flags

  verbs=(
    'list:List resources'
    'search:Search resources with filters'
    'get:Get resource by key'
    'create:Create resource'
    'cancel:Cancel resource'
    'await:Await resource completion'
    'complete:Complete resource'
    'fail:Fail a job'
    'activate:Activate jobs by type'
    'resolve:Resolve incident'
    'publish:Publish message'
    'correlate:Correlate message'
    'deploy:Deploy BPMN/DMN/forms'
    'run:Deploy and start process'
    'watch:Watch files for changes and auto-deploy'
    'add:Add a profile'
    'remove:Remove a profile'
    'rm:Remove a profile'
    'load:Load a c8ctl plugin'
    'unload:Unload a c8ctl plugin'
    'sync:Synchronize plugins from registry'
    'upgrade:Upgrade a plugin'
    'downgrade:Downgrade a plugin'
    'init:Create a new plugin from template'
    'use:Set active profile or tenant'
    'output:Set output format'
    'completion:Generate shell completion script'
    'help:Show help or detailed help for a command'
  )

  flags=(
    '--help[Show help]'
    '-h[Show help]'
    '--version[Show version]'
    '-v[Show version]'
    '--profile[Use specific profile]:profile:'
    '--from[Load plugin from URL]:url:'
    '--all[Show all results]'
    '--bpmnProcessId[Process definition ID]:id:'
    '--id[Process definition ID (alias for --bpmnProcessId)]:id:'
    '--processInstanceKey[Process instance key]:key:'
    '--processDefinitionKey[Process definition key]:key:'
    '--parentProcessInstanceKey[Parent process instance key]:key:'
    '--variables[JSON variables]:json:'
    '--state[Filter by state]:state:'
    '--assignee[Filter by assignee]:assignee:'
    '--type[Job type]:type:'
    '--correlationKey[Message correlation key]:key:'
    '--timeToLive[Message TTL in ms]:ttl:'
    '--maxJobsToActivate[Maximum jobs to activate]:count:'
    '--timeout[Job timeout in ms]:timeout:'
    '--worker[Worker name]:name:'
    '--retries[Number of retries]:count:'
    '--errorMessage[Error message]:message:'
    '--baseUrl[Cluster base URL]:url:'
    '--clientId[OAuth client ID]:id:'
    '--clientSecret[OAuth client secret]:secret:'
    '--audience[OAuth audience]:audience:'
    '--oAuthUrl[OAuth token endpoint]:url:'
    '--defaultTenantId[Default tenant ID]:id:'
    '--version[Process definition version]:version:'
    '--awaitCompletion[Wait for process instance to complete]'
    '--fetchVariables[Comma-separated variable names]:variables:'
    '--requestTimeout[Timeout in milliseconds for process completion]:milliseconds:'
    '--name[Variable or resource name]:name:'
    '--key[Resource key]:key:'
    '--elementId[Element ID]:id:'
    '--errorType[Error type]:type:'
    '--value[Variable value]:value:'
    '--scopeKey[Scope key]:key:'
    '--fullValue[Return full variable values]'
    '--userTask[Get form for a user task]'
    '--ut[Get form for a user task (alias for --userTask)]'
    '--processDefinition[Get start form for a process definition]'
    '--pd[Get start form for a process definition (alias for --processDefinition)]'
    '--iname[Case-insensitive name filter]:pattern:'
    '--iid[Case-insensitive process definition ID filter]:pattern:'
    '--iassignee[Case-insensitive assignee filter]:pattern:'
    '--ierrorMessage[Case-insensitive error message filter]:pattern:'
    '--itype[Case-insensitive job type filter]:pattern:'
    '--ivalue[Case-insensitive variable value filter]:pattern:'
  )

  case \$CURRENT in
    2)
      _describe 'command' verbs
      ;;
    3)
      case "\${words[2]}" in
        list)
          resources=(
            'process-instances:List process instances'
            'process-instance:List process instances'
            'pi:List process instances'
            'user-tasks:List user tasks'
            'user-task:List user tasks'
            'ut:List user tasks'
            'incidents:List incidents'
            'incident:List incidents'
            'inc:List incidents'
            'jobs:List jobs'
            'profiles:List profiles'
            'profile:List profiles'
            'plugins:List plugins'
            'plugin:List plugins'
          )
          _describe 'resource' resources
          ;;
        search)
          resources=(
            'process-instances:Search process instances'
            'process-instance:Search process instances'
            'pi:Search process instances'
            'process-definitions:Search process definitions'
            'process-definition:Search process definitions'
            'pd:Search process definitions'
            'user-tasks:Search user tasks'
            'user-task:Search user tasks'
            'ut:Search user tasks'
            'incidents:Search incidents'
            'incident:Search incidents'
            'inc:Search incidents'
            'jobs:Search jobs'
            'variables:Search variables'
            'variable:Search variables'
          )
          _describe 'resource' resources
          ;;
        get)
          resources=(
            'process-instance:Get process instance'
            'pi:Get process instance'
            'process-definition:Get process definition'
            'pd:Get process definition'
            'incident:Get incident'
            'inc:Get incident'
            'topology:Get cluster topology'
            'form:Get form for user task or process definition'
          )
          _describe 'resource' resources
          ;;
        create)
          resources=(
            'process-instance:Create process instance'
            'pi:Create process instance'
          )
          _describe 'resource' resources
          ;;
        cancel)
          resources=(
            'process-instance:Cancel process instance'
            'pi:Cancel process instance'
          )
          _describe 'resource' resources
          ;;
        await)
          resources=(
            'process-instance:Await process instance completion'
            'pi:Await process instance completion'
          )
          _describe 'resource' resources
          ;;
        complete)
          resources=(
            'user-task:Complete user task'
            'ut:Complete user task'
            'job:Complete job'
          )
          _describe 'resource' resources
          ;;
        fail)
          resources=(
            'job:Fail job'
          )
          _describe 'resource' resources
          ;;
        activate)
          resources=(
            'jobs:Activate jobs'
          )
          _describe 'resource' resources
          ;;
        resolve)
          resources=(
            'incident:Resolve incident'
            'inc:Resolve incident'
          )
          _describe 'resource' resources
          ;;
        publish)
          resources=(
            'message:Publish message'
            'msg:Publish message'
          )
          _describe 'resource' resources
          ;;
        correlate)
          resources=(
            'message:Correlate message'
            'msg:Correlate message'
          )
          _describe 'resource' resources
          ;;
        add)
          resources=(
            'profile:Add profile'
          )
          _describe 'resource' resources
          ;;
        remove|rm)
          resources=(
            'profile:Remove profile'
          )
          _describe 'resource' resources
          ;;
        load)
          resources=(
            'plugin:Load plugin'
          )
          _describe 'resource' resources
          ;;
        unload)
          resources=(
            'plugin:Unload plugin'
          )
          _describe 'resource' resources
          ;;
        sync)
          resources=(
            'plugin:Synchronize plugin'
            'plugins:Synchronize plugins'
          )
          _describe 'resource' resources
          ;;
        upgrade)
          resources=(
            'plugin:Upgrade plugin'
          )
          _describe 'resource' resources
          ;;
        downgrade)
          resources=(
            'plugin:Downgrade plugin'
          )
          _describe 'resource' resources
          ;;
        init)
          resources=(
            'plugin:Create new plugin from template'
          )
          _describe 'resource' resources
          ;;
        use)
          resources=(
            'profile:Set active profile'
            'tenant:Set active tenant'
          )
          _describe 'resource' resources
          ;;
        output)
          resources=(
            'json:JSON output'
            'text:Text output'
          )
          _describe 'resource' resources
          ;;
        completion)
          resources=(
            'bash:Generate bash completion'
            'zsh:Generate zsh completion'
            'fish:Generate fish completion'
          )
          _describe 'resource' resources
          ;;
        help)
          resources=(
            'list:Show list command help'
            'get:Show get command help'
            'create:Show create command help'
            'complete:Show complete command help'
            'await:Show await command help'
            'search:Show search command help'
            'deploy:Show deploy command help'
            'run:Show run command help'
            'watch:Show watch command help'
            'cancel:Show cancel command help'
            'resolve:Show resolve command help'
            'fail:Show fail command help'
            'activate:Show activate command help'
            'publish:Show publish command help'
            'correlate:Show correlate command help'
            'upgrade:Show upgrade command help'
            'downgrade:Show downgrade command help'
            'init:Show init command help'
            'plugin:Show plugin management help'
            'plugins:Alias for plugin management help'
          )
          _describe 'resource' resources
          ;;
        deploy|run|watch)
          _files
          ;;
      esac
      ;;
    *)
      _arguments \${flags[@]}
      ;;
  esac
}

# compdef is handled by the #compdef directive at the top
`;
}

/**
 * Generate fish completion script
 */
function generateFishCompletion(): string {
  return `# c8ctl fish completion

# Remove all existing completions for c8ctl and c8
complete -c c8ctl -e
complete -c c8 -e

# Global flags
complete -c c8ctl -s h -l help -d 'Show help'
complete -c c8 -s h -l help -d 'Show help'
complete -c c8ctl -s v -l version -d 'Show version'
complete -c c8 -s v -l version -d 'Show version'
complete -c c8ctl -l profile -d 'Use specific profile' -r
complete -c c8 -l profile -d 'Use specific profile' -r
complete -c c8ctl -l from -d 'Load plugin from URL' -r
complete -c c8 -l from -d 'Load plugin from URL' -r
complete -c c8ctl -l all -d 'Show all results'
complete -c c8 -l all -d 'Show all results'
complete -c c8ctl -l bpmnProcessId -d 'Process definition ID' -r
complete -c c8 -l bpmnProcessId -d 'Process definition ID' -r
complete -c c8ctl -l id -d 'Process definition ID (alias for --bpmnProcessId)' -r
complete -c c8 -l id -d 'Process definition ID (alias for --bpmnProcessId)' -r
complete -c c8ctl -l processInstanceKey -d 'Process instance key' -r
complete -c c8 -l processInstanceKey -d 'Process instance key' -r
complete -c c8ctl -l processDefinitionKey -d 'Process definition key' -r
complete -c c8 -l processDefinitionKey -d 'Process definition key' -r
complete -c c8ctl -l parentProcessInstanceKey -d 'Parent process instance key' -r
complete -c c8 -l parentProcessInstanceKey -d 'Parent process instance key' -r
complete -c c8ctl -l variables -d 'JSON variables' -r
complete -c c8 -l variables -d 'JSON variables' -r
complete -c c8ctl -l state -d 'Filter by state' -r
complete -c c8 -l state -d 'Filter by state' -r
complete -c c8ctl -l assignee -d 'Filter by assignee' -r
complete -c c8 -l assignee -d 'Filter by assignee' -r
complete -c c8ctl -l type -d 'Job type' -r
complete -c c8 -l type -d 'Job type' -r
complete -c c8ctl -l correlationKey -d 'Message correlation key' -r
complete -c c8 -l correlationKey -d 'Message correlation key' -r
complete -c c8ctl -l timeToLive -d 'Message TTL in ms' -r
complete -c c8 -l timeToLive -d 'Message TTL in ms' -r
complete -c c8ctl -l maxJobsToActivate -d 'Maximum jobs to activate' -r
complete -c c8 -l maxJobsToActivate -d 'Maximum jobs to activate' -r
complete -c c8ctl -l timeout -d 'Job timeout in ms' -r
complete -c c8 -l timeout -d 'Job timeout in ms' -r
complete -c c8ctl -l worker -d 'Worker name' -r
complete -c c8 -l worker -d 'Worker name' -r
complete -c c8ctl -l retries -d 'Number of retries' -r
complete -c c8 -l retries -d 'Number of retries' -r
complete -c c8ctl -l errorMessage -d 'Error message' -r
complete -c c8 -l errorMessage -d 'Error message' -r
complete -c c8ctl -l baseUrl -d 'Cluster base URL' -r
complete -c c8 -l baseUrl -d 'Cluster base URL' -r
complete -c c8ctl -l clientId -d 'OAuth client ID' -r
complete -c c8 -l clientId -d 'OAuth client ID' -r
complete -c c8ctl -l clientSecret -d 'OAuth client secret' -r
complete -c c8 -l clientSecret -d 'OAuth client secret' -r
complete -c c8ctl -l audience -d 'OAuth audience' -r
complete -c c8 -l audience -d 'OAuth audience' -r
complete -c c8ctl -l oAuthUrl -d 'OAuth token endpoint' -r
complete -c c8 -l oAuthUrl -d 'OAuth token endpoint' -r
complete -c c8ctl -l defaultTenantId -d 'Default tenant ID' -r
complete -c c8 -l defaultTenantId -d 'Default tenant ID' -r
complete -c c8ctl -l version -d 'Process definition version' -r
complete -c c8 -l version -d 'Process definition version' -r
complete -c c8ctl -l awaitCompletion -d 'Wait for process instance to complete'
complete -c c8 -l awaitCompletion -d 'Wait for process instance to complete'
complete -c c8ctl -l fetchVariables -d 'Comma-separated variable names' -r
complete -c c8 -l fetchVariables -d 'Comma-separated variable names' -r
complete -c c8ctl -l requestTimeout -d 'Timeout in milliseconds for process completion' -r
complete -c c8 -l requestTimeout -d 'Timeout in milliseconds for process completion' -r
complete -c c8ctl -l name -d 'Variable or resource name' -r
complete -c c8 -l name -d 'Variable or resource name' -r
complete -c c8ctl -l key -d 'Resource key' -r
complete -c c8 -l key -d 'Resource key' -r
complete -c c8ctl -l elementId -d 'Element ID' -r
complete -c c8 -l elementId -d 'Element ID' -r
complete -c c8ctl -l errorType -d 'Error type' -r
complete -c c8 -l errorType -d 'Error type' -r
complete -c c8ctl -l value -d 'Variable value' -r
complete -c c8 -l value -d 'Variable value' -r
complete -c c8ctl -l scopeKey -d 'Scope key' -r
complete -c c8 -l scopeKey -d 'Scope key' -r
complete -c c8ctl -l fullValue -d 'Return full variable values'
complete -c c8 -l fullValue -d 'Return full variable values'
complete -c c8ctl -l userTask -d 'Get form for a user task'
complete -c c8 -l userTask -d 'Get form for a user task'
complete -c c8ctl -l ut -d 'Get form for a user task (alias for --userTask)'
complete -c c8 -l ut -d 'Get form for a user task (alias for --userTask)'
complete -c c8ctl -l processDefinition -d 'Get start form for a process definition'
complete -c c8 -l processDefinition -d 'Get start form for a process definition'
complete -c c8ctl -l pd -d 'Get start form for a process definition (alias for --processDefinition)'
complete -c c8 -l pd -d 'Get start form for a process definition (alias for --processDefinition)'
complete -c c8ctl -l iname -d 'Case-insensitive name filter' -r
complete -c c8 -l iname -d 'Case-insensitive name filter' -r
complete -c c8ctl -l iid -d 'Case-insensitive process definition ID filter' -r
complete -c c8 -l iid -d 'Case-insensitive process definition ID filter' -r
complete -c c8ctl -l iassignee -d 'Case-insensitive assignee filter' -r
complete -c c8 -l iassignee -d 'Case-insensitive assignee filter' -r
complete -c c8ctl -l ierrorMessage -d 'Case-insensitive error message filter' -r
complete -c c8 -l ierrorMessage -d 'Case-insensitive error message filter' -r
complete -c c8ctl -l itype -d 'Case-insensitive job type filter' -r
complete -c c8 -l itype -d 'Case-insensitive job type filter' -r
complete -c c8ctl -l ivalue -d 'Case-insensitive variable value filter' -r
complete -c c8 -l ivalue -d 'Case-insensitive variable value filter' -r

# Commands (verbs) - only suggest when no command is given yet
complete -c c8ctl -n '__fish_use_subcommand' -a 'list' -d 'List resources'
complete -c c8 -n '__fish_use_subcommand' -a 'list' -d 'List resources'
complete -c c8ctl -n '__fish_use_subcommand' -a 'search' -d 'Search resources with filters'
complete -c c8 -n '__fish_use_subcommand' -a 'search' -d 'Search resources with filters'
complete -c c8ctl -n '__fish_use_subcommand' -a 'get' -d 'Get resource by key'
complete -c c8 -n '__fish_use_subcommand' -a 'get' -d 'Get resource by key'
complete -c c8ctl -n '__fish_use_subcommand' -a 'create' -d 'Create resource'
complete -c c8 -n '__fish_use_subcommand' -a 'create' -d 'Create resource'
complete -c c8ctl -n '__fish_use_subcommand' -a 'cancel' -d 'Cancel resource'
complete -c c8 -n '__fish_use_subcommand' -a 'cancel' -d 'Cancel resource'
complete -c c8ctl -n '__fish_use_subcommand' -a 'await' -d 'Await resource completion'
complete -c c8 -n '__fish_use_subcommand' -a 'await' -d 'Await resource completion'
complete -c c8ctl -n '__fish_use_subcommand' -a 'complete' -d 'Complete resource'
complete -c c8 -n '__fish_use_subcommand' -a 'complete' -d 'Complete resource'
complete -c c8ctl -n '__fish_use_subcommand' -a 'fail' -d 'Fail a job'
complete -c c8 -n '__fish_use_subcommand' -a 'fail' -d 'Fail a job'
complete -c c8ctl -n '__fish_use_subcommand' -a 'activate' -d 'Activate jobs by type'
complete -c c8 -n '__fish_use_subcommand' -a 'activate' -d 'Activate jobs by type'
complete -c c8ctl -n '__fish_use_subcommand' -a 'resolve' -d 'Resolve incident'
complete -c c8 -n '__fish_use_subcommand' -a 'resolve' -d 'Resolve incident'
complete -c c8ctl -n '__fish_use_subcommand' -a 'publish' -d 'Publish message'
complete -c c8 -n '__fish_use_subcommand' -a 'publish' -d 'Publish message'
complete -c c8ctl -n '__fish_use_subcommand' -a 'correlate' -d 'Correlate message'
complete -c c8 -n '__fish_use_subcommand' -a 'correlate' -d 'Correlate message'
complete -c c8ctl -n '__fish_use_subcommand' -a 'deploy' -d 'Deploy BPMN/DMN/forms'
complete -c c8 -n '__fish_use_subcommand' -a 'deploy' -d 'Deploy BPMN/DMN/forms'
complete -c c8ctl -n '__fish_use_subcommand' -a 'run' -d 'Deploy and start process'
complete -c c8 -n '__fish_use_subcommand' -a 'run' -d 'Deploy and start process'
complete -c c8ctl -n '__fish_use_subcommand' -a 'watch' -d 'Watch files and auto-deploy'
complete -c c8 -n '__fish_use_subcommand' -a 'watch' -d 'Watch files and auto-deploy'
complete -c c8ctl -n '__fish_use_subcommand' -a 'add' -d 'Add a profile'
complete -c c8 -n '__fish_use_subcommand' -a 'add' -d 'Add a profile'
complete -c c8ctl -n '__fish_use_subcommand' -a 'remove' -d 'Remove a profile'
complete -c c8 -n '__fish_use_subcommand' -a 'remove' -d 'Remove a profile'
complete -c c8ctl -n '__fish_use_subcommand' -a 'rm' -d 'Remove a profile'
complete -c c8 -n '__fish_use_subcommand' -a 'rm' -d 'Remove a profile'
complete -c c8ctl -n '__fish_use_subcommand' -a 'load' -d 'Load a c8ctl plugin'
complete -c c8 -n '__fish_use_subcommand' -a 'load' -d 'Load a c8ctl plugin'
complete -c c8ctl -n '__fish_use_subcommand' -a 'unload' -d 'Unload a c8ctl plugin'
complete -c c8 -n '__fish_use_subcommand' -a 'unload' -d 'Unload a c8ctl plugin'
complete -c c8ctl -n '__fish_use_subcommand' -a 'sync' -d 'Synchronize plugins from registry'
complete -c c8 -n '__fish_use_subcommand' -a 'sync' -d 'Synchronize plugins from registry'
complete -c c8ctl -n '__fish_use_subcommand' -a 'upgrade' -d 'Upgrade a plugin'
complete -c c8 -n '__fish_use_subcommand' -a 'upgrade' -d 'Upgrade a plugin'
complete -c c8ctl -n '__fish_use_subcommand' -a 'downgrade' -d 'Downgrade a plugin'
complete -c c8 -n '__fish_use_subcommand' -a 'downgrade' -d 'Downgrade a plugin'
complete -c c8ctl -n '__fish_use_subcommand' -a 'init' -d 'Create a new plugin from template'
complete -c c8 -n '__fish_use_subcommand' -a 'init' -d 'Create a new plugin from template'
complete -c c8ctl -n '__fish_use_subcommand' -a 'use' -d 'Set active profile or tenant'
complete -c c8 -n '__fish_use_subcommand' -a 'use' -d 'Set active profile or tenant'
complete -c c8ctl -n '__fish_use_subcommand' -a 'output' -d 'Set output format'
complete -c c8 -n '__fish_use_subcommand' -a 'output' -d 'Set output format'
complete -c c8ctl -n '__fish_use_subcommand' -a 'help' -d 'Show help or detailed help for a command'
complete -c c8 -n '__fish_use_subcommand' -a 'help' -d 'Show help or detailed help for a command'
complete -c c8ctl -n '__fish_use_subcommand' -a 'completion' -d 'Generate shell completion script'
complete -c c8 -n '__fish_use_subcommand' -a 'completion' -d 'Generate shell completion script'

# Resources for 'list' command
complete -c c8ctl -n '__fish_seen_subcommand_from list' -a 'process-instances' -d 'List process instances'
complete -c c8 -n '__fish_seen_subcommand_from list' -a 'process-instances' -d 'List process instances'
complete -c c8ctl -n '__fish_seen_subcommand_from list' -a 'process-instance' -d 'List process instances'
complete -c c8 -n '__fish_seen_subcommand_from list' -a 'process-instance' -d 'List process instances'
complete -c c8ctl -n '__fish_seen_subcommand_from list' -a 'pi' -d 'List process instances'
complete -c c8 -n '__fish_seen_subcommand_from list' -a 'pi' -d 'List process instances'
complete -c c8ctl -n '__fish_seen_subcommand_from list' -a 'user-tasks' -d 'List user tasks'
complete -c c8 -n '__fish_seen_subcommand_from list' -a 'user-tasks' -d 'List user tasks'
complete -c c8ctl -n '__fish_seen_subcommand_from list' -a 'user-task' -d 'List user tasks'
complete -c c8 -n '__fish_seen_subcommand_from list' -a 'user-task' -d 'List user tasks'
complete -c c8ctl -n '__fish_seen_subcommand_from list' -a 'ut' -d 'List user tasks'
complete -c c8 -n '__fish_seen_subcommand_from list' -a 'ut' -d 'List user tasks'
complete -c c8ctl -n '__fish_seen_subcommand_from list' -a 'incidents' -d 'List incidents'
complete -c c8 -n '__fish_seen_subcommand_from list' -a 'incidents' -d 'List incidents'
complete -c c8ctl -n '__fish_seen_subcommand_from list' -a 'incident' -d 'List incidents'
complete -c c8 -n '__fish_seen_subcommand_from list' -a 'incident' -d 'List incidents'
complete -c c8ctl -n '__fish_seen_subcommand_from list' -a 'inc' -d 'List incidents'
complete -c c8 -n '__fish_seen_subcommand_from list' -a 'inc' -d 'List incidents'
complete -c c8ctl -n '__fish_seen_subcommand_from list' -a 'jobs' -d 'List jobs'
complete -c c8 -n '__fish_seen_subcommand_from list' -a 'jobs' -d 'List jobs'
complete -c c8ctl -n '__fish_seen_subcommand_from list' -a 'profiles' -d 'List profiles'
complete -c c8 -n '__fish_seen_subcommand_from list' -a 'profiles' -d 'List profiles'
complete -c c8ctl -n '__fish_seen_subcommand_from list' -a 'profile' -d 'List profiles'
complete -c c8 -n '__fish_seen_subcommand_from list' -a 'profile' -d 'List profiles'
complete -c c8ctl -n '__fish_seen_subcommand_from list' -a 'plugins' -d 'List plugins'
complete -c c8 -n '__fish_seen_subcommand_from list' -a 'plugins' -d 'List plugins'
complete -c c8ctl -n '__fish_seen_subcommand_from list' -a 'plugin' -d 'List plugins'
complete -c c8 -n '__fish_seen_subcommand_from list' -a 'plugin' -d 'List plugins'

# Resources for 'search' command
complete -c c8ctl -n '__fish_seen_subcommand_from search' -a 'process-instances' -d 'Search process instances'
complete -c c8 -n '__fish_seen_subcommand_from search' -a 'process-instances' -d 'Search process instances'
complete -c c8ctl -n '__fish_seen_subcommand_from search' -a 'process-instance' -d 'Search process instances'
complete -c c8 -n '__fish_seen_subcommand_from search' -a 'process-instance' -d 'Search process instances'
complete -c c8ctl -n '__fish_seen_subcommand_from search' -a 'pi' -d 'Search process instances'
complete -c c8 -n '__fish_seen_subcommand_from search' -a 'pi' -d 'Search process instances'
complete -c c8ctl -n '__fish_seen_subcommand_from search' -a 'process-definitions' -d 'Search process definitions'
complete -c c8 -n '__fish_seen_subcommand_from search' -a 'process-definitions' -d 'Search process definitions'
complete -c c8ctl -n '__fish_seen_subcommand_from search' -a 'process-definition' -d 'Search process definitions'
complete -c c8 -n '__fish_seen_subcommand_from search' -a 'process-definition' -d 'Search process definitions'
complete -c c8ctl -n '__fish_seen_subcommand_from search' -a 'pd' -d 'Search process definitions'
complete -c c8 -n '__fish_seen_subcommand_from search' -a 'pd' -d 'Search process definitions'
complete -c c8ctl -n '__fish_seen_subcommand_from search' -a 'user-tasks' -d 'Search user tasks'
complete -c c8 -n '__fish_seen_subcommand_from search' -a 'user-tasks' -d 'Search user tasks'
complete -c c8ctl -n '__fish_seen_subcommand_from search' -a 'user-task' -d 'Search user tasks'
complete -c c8 -n '__fish_seen_subcommand_from search' -a 'user-task' -d 'Search user tasks'
complete -c c8ctl -n '__fish_seen_subcommand_from search' -a 'ut' -d 'Search user tasks'
complete -c c8 -n '__fish_seen_subcommand_from search' -a 'ut' -d 'Search user tasks'
complete -c c8ctl -n '__fish_seen_subcommand_from search' -a 'incidents' -d 'Search incidents'
complete -c c8 -n '__fish_seen_subcommand_from search' -a 'incidents' -d 'Search incidents'
complete -c c8ctl -n '__fish_seen_subcommand_from search' -a 'incident' -d 'Search incidents'
complete -c c8 -n '__fish_seen_subcommand_from search' -a 'incident' -d 'Search incidents'
complete -c c8ctl -n '__fish_seen_subcommand_from search' -a 'inc' -d 'Search incidents'
complete -c c8 -n '__fish_seen_subcommand_from search' -a 'inc' -d 'Search incidents'
complete -c c8ctl -n '__fish_seen_subcommand_from search' -a 'jobs' -d 'Search jobs'
complete -c c8 -n '__fish_seen_subcommand_from search' -a 'jobs' -d 'Search jobs'
complete -c c8ctl -n '__fish_seen_subcommand_from search' -a 'variables' -d 'Search variables'
complete -c c8 -n '__fish_seen_subcommand_from search' -a 'variables' -d 'Search variables'
complete -c c8ctl -n '__fish_seen_subcommand_from search' -a 'variable' -d 'Search variables'
complete -c c8 -n '__fish_seen_subcommand_from search' -a 'variable' -d 'Search variables'

# Resources for 'get' command
complete -c c8ctl -n '__fish_seen_subcommand_from get' -a 'process-instance' -d 'Get process instance'
complete -c c8 -n '__fish_seen_subcommand_from get' -a 'process-instance' -d 'Get process instance'
complete -c c8ctl -n '__fish_seen_subcommand_from get' -a 'pi' -d 'Get process instance'
complete -c c8 -n '__fish_seen_subcommand_from get' -a 'pi' -d 'Get process instance'
complete -c c8ctl -n '__fish_seen_subcommand_from get' -a 'process-definition' -d 'Get process definition'
complete -c c8 -n '__fish_seen_subcommand_from get' -a 'process-definition' -d 'Get process definition'
complete -c c8ctl -n '__fish_seen_subcommand_from get' -a 'pd' -d 'Get process definition'
complete -c c8 -n '__fish_seen_subcommand_from get' -a 'pd' -d 'Get process definition'
complete -c c8ctl -n '__fish_seen_subcommand_from get' -a 'incident' -d 'Get incident'
complete -c c8 -n '__fish_seen_subcommand_from get' -a 'incident' -d 'Get incident'
complete -c c8ctl -n '__fish_seen_subcommand_from get' -a 'inc' -d 'Get incident'
complete -c c8 -n '__fish_seen_subcommand_from get' -a 'inc' -d 'Get incident'
complete -c c8ctl -n '__fish_seen_subcommand_from get' -a 'topology' -d 'Get cluster topology'
complete -c c8 -n '__fish_seen_subcommand_from get' -a 'topology' -d 'Get cluster topology'
complete -c c8ctl -n '__fish_seen_subcommand_from get' -a 'form' -d 'Get form for user task or process definition'
complete -c c8 -n '__fish_seen_subcommand_from get' -a 'form' -d 'Get form for user task or process definition'

# Resources for 'create' command
complete -c c8ctl -n '__fish_seen_subcommand_from create' -a 'process-instance' -d 'Create process instance'
complete -c c8 -n '__fish_seen_subcommand_from create' -a 'process-instance' -d 'Create process instance'
complete -c c8ctl -n '__fish_seen_subcommand_from create' -a 'pi' -d 'Create process instance'
complete -c c8 -n '__fish_seen_subcommand_from create' -a 'pi' -d 'Create process instance'

# Resources for 'cancel' command
complete -c c8ctl -n '__fish_seen_subcommand_from cancel' -a 'process-instance' -d 'Cancel process instance'
complete -c c8 -n '__fish_seen_subcommand_from cancel' -a 'process-instance' -d 'Cancel process instance'
complete -c c8ctl -n '__fish_seen_subcommand_from cancel' -a 'pi' -d 'Cancel process instance'
complete -c c8 -n '__fish_seen_subcommand_from cancel' -a 'pi' -d 'Cancel process instance'

# Resources for 'await' command
complete -c c8ctl -n '__fish_seen_subcommand_from await' -a 'process-instance' -d 'Await process instance completion'
complete -c c8 -n '__fish_seen_subcommand_from await' -a 'process-instance' -d 'Await process instance completion'
complete -c c8ctl -n '__fish_seen_subcommand_from await' -a 'pi' -d 'Await process instance completion'
complete -c c8 -n '__fish_seen_subcommand_from await' -a 'pi' -d 'Await process instance completion'

# Resources for 'complete' command
complete -c c8ctl -n '__fish_seen_subcommand_from complete' -a 'user-task' -d 'Complete user task'
complete -c c8 -n '__fish_seen_subcommand_from complete' -a 'user-task' -d 'Complete user task'
complete -c c8ctl -n '__fish_seen_subcommand_from complete' -a 'ut' -d 'Complete user task'
complete -c c8 -n '__fish_seen_subcommand_from complete' -a 'ut' -d 'Complete user task'
complete -c c8ctl -n '__fish_seen_subcommand_from complete' -a 'job' -d 'Complete job'
complete -c c8 -n '__fish_seen_subcommand_from complete' -a 'job' -d 'Complete job'

# Resources for 'fail' command
complete -c c8ctl -n '__fish_seen_subcommand_from fail' -a 'job' -d 'Fail job'
complete -c c8 -n '__fish_seen_subcommand_from fail' -a 'job' -d 'Fail job'

# Resources for 'activate' command
complete -c c8ctl -n '__fish_seen_subcommand_from activate' -a 'jobs' -d 'Activate jobs'
complete -c c8 -n '__fish_seen_subcommand_from activate' -a 'jobs' -d 'Activate jobs'

# Resources for 'resolve' command
complete -c c8ctl -n '__fish_seen_subcommand_from resolve' -a 'incident' -d 'Resolve incident'
complete -c c8 -n '__fish_seen_subcommand_from resolve' -a 'incident' -d 'Resolve incident'
complete -c c8ctl -n '__fish_seen_subcommand_from resolve' -a 'inc' -d 'Resolve incident'
complete -c c8 -n '__fish_seen_subcommand_from resolve' -a 'inc' -d 'Resolve incident'

# Resources for 'publish' command
complete -c c8ctl -n '__fish_seen_subcommand_from publish' -a 'message' -d 'Publish message'
complete -c c8 -n '__fish_seen_subcommand_from publish' -a 'message' -d 'Publish message'
complete -c c8ctl -n '__fish_seen_subcommand_from publish' -a 'msg' -d 'Publish message'
complete -c c8 -n '__fish_seen_subcommand_from publish' -a 'msg' -d 'Publish message'

# Resources for 'correlate' command
complete -c c8ctl -n '__fish_seen_subcommand_from correlate' -a 'message' -d 'Correlate message'
complete -c c8 -n '__fish_seen_subcommand_from correlate' -a 'message' -d 'Correlate message'
complete -c c8ctl -n '__fish_seen_subcommand_from correlate' -a 'msg' -d 'Correlate message'
complete -c c8 -n '__fish_seen_subcommand_from correlate' -a 'msg' -d 'Correlate message'

# Resources for 'add' command
complete -c c8ctl -n '__fish_seen_subcommand_from add' -a 'profile' -d 'Add profile'
complete -c c8 -n '__fish_seen_subcommand_from add' -a 'profile' -d 'Add profile'

# Resources for 'remove' and 'rm' commands
complete -c c8ctl -n '__fish_seen_subcommand_from remove' -a 'profile' -d 'Remove profile'
complete -c c8 -n '__fish_seen_subcommand_from remove' -a 'profile' -d 'Remove profile'
complete -c c8ctl -n '__fish_seen_subcommand_from rm' -a 'profile' -d 'Remove profile'
complete -c c8 -n '__fish_seen_subcommand_from rm' -a 'profile' -d 'Remove profile'

# Resources for 'load' command
complete -c c8ctl -n '__fish_seen_subcommand_from load' -a 'plugin' -d 'Load plugin'
complete -c c8 -n '__fish_seen_subcommand_from load' -a 'plugin' -d 'Load plugin'

# Resources for 'unload' command
complete -c c8ctl -n '__fish_seen_subcommand_from unload' -a 'plugin' -d 'Unload plugin'
complete -c c8 -n '__fish_seen_subcommand_from unload' -a 'plugin' -d 'Unload plugin'

# Resources for 'sync' command
complete -c c8ctl -n '__fish_seen_subcommand_from sync' -a 'plugin' -d 'Synchronize plugin'
complete -c c8 -n '__fish_seen_subcommand_from sync' -a 'plugin' -d 'Synchronize plugin'
complete -c c8ctl -n '__fish_seen_subcommand_from sync' -a 'plugins' -d 'Synchronize plugins'
complete -c c8 -n '__fish_seen_subcommand_from sync' -a 'plugins' -d 'Synchronize plugins'

# Resources for 'upgrade' command
complete -c c8ctl -n '__fish_seen_subcommand_from upgrade' -a 'plugin' -d 'Upgrade plugin'
complete -c c8 -n '__fish_seen_subcommand_from upgrade' -a 'plugin' -d 'Upgrade plugin'

# Resources for 'downgrade' command
complete -c c8ctl -n '__fish_seen_subcommand_from downgrade' -a 'plugin' -d 'Downgrade plugin'
complete -c c8 -n '__fish_seen_subcommand_from downgrade' -a 'plugin' -d 'Downgrade plugin'

# Resources for 'init' command
complete -c c8ctl -n '__fish_seen_subcommand_from init' -a 'plugin' -d 'Create new plugin from template'
complete -c c8 -n '__fish_seen_subcommand_from init' -a 'plugin' -d 'Create new plugin from template'

# Resources for 'use' command
complete -c c8ctl -n '__fish_seen_subcommand_from use' -a 'profile' -d 'Set active profile'
complete -c c8 -n '__fish_seen_subcommand_from use' -a 'profile' -d 'Set active profile'
complete -c c8ctl -n '__fish_seen_subcommand_from use' -a 'tenant' -d 'Set active tenant'
complete -c c8 -n '__fish_seen_subcommand_from use' -a 'tenant' -d 'Set active tenant'

# Resources for 'output' command
complete -c c8ctl -n '__fish_seen_subcommand_from output' -a 'json' -d 'JSON output'
complete -c c8 -n '__fish_seen_subcommand_from output' -a 'json' -d 'JSON output'
complete -c c8ctl -n '__fish_seen_subcommand_from output' -a 'text' -d 'Text output'
complete -c c8 -n '__fish_seen_subcommand_from output' -a 'text' -d 'Text output'

# Resources for 'completion' command
complete -c c8ctl -n '__fish_seen_subcommand_from completion' -a 'bash' -d 'Generate bash completion'
complete -c c8 -n '__fish_seen_subcommand_from completion' -a 'bash' -d 'Generate bash completion'
complete -c c8ctl -n '__fish_seen_subcommand_from completion' -a 'zsh' -d 'Generate zsh completion'
complete -c c8 -n '__fish_seen_subcommand_from completion' -a 'zsh' -d 'Generate zsh completion'
complete -c c8ctl -n '__fish_seen_subcommand_from completion' -a 'fish' -d 'Generate fish completion'
complete -c c8 -n '__fish_seen_subcommand_from completion' -a 'fish' -d 'Generate fish completion'

# Resources for 'help' command
complete -c c8ctl -n '__fish_seen_subcommand_from help' -a 'list' -d 'Show list command help'
complete -c c8 -n '__fish_seen_subcommand_from help' -a 'list' -d 'Show list command help'
complete -c c8ctl -n '__fish_seen_subcommand_from help' -a 'get' -d 'Show get command help'
complete -c c8 -n '__fish_seen_subcommand_from help' -a 'get' -d 'Show get command help'
complete -c c8ctl -n '__fish_seen_subcommand_from help' -a 'create' -d 'Show create command help'
complete -c c8 -n '__fish_seen_subcommand_from help' -a 'create' -d 'Show create command help'
complete -c c8ctl -n '__fish_seen_subcommand_from help' -a 'complete' -d 'Show complete command help'
complete -c c8 -n '__fish_seen_subcommand_from help' -a 'complete' -d 'Show complete command help'
complete -c c8ctl -n '__fish_seen_subcommand_from help' -a 'await' -d 'Show await command help'
complete -c c8 -n '__fish_seen_subcommand_from help' -a 'await' -d 'Show await command help'
complete -c c8ctl -n '__fish_seen_subcommand_from help' -a 'search' -d 'Show search command help'
complete -c c8 -n '__fish_seen_subcommand_from help' -a 'search' -d 'Show search command help'
complete -c c8ctl -n '__fish_seen_subcommand_from help' -a 'deploy' -d 'Show deploy command help'
complete -c c8 -n '__fish_seen_subcommand_from help' -a 'deploy' -d 'Show deploy command help'
complete -c c8ctl -n '__fish_seen_subcommand_from help' -a 'run' -d 'Show run command help'
complete -c c8 -n '__fish_seen_subcommand_from help' -a 'run' -d 'Show run command help'
complete -c c8ctl -n '__fish_seen_subcommand_from help' -a 'watch' -d 'Show watch command help'
complete -c c8 -n '__fish_seen_subcommand_from help' -a 'watch' -d 'Show watch command help'
complete -c c8ctl -n '__fish_seen_subcommand_from help' -a 'cancel' -d 'Show cancel command help'
complete -c c8 -n '__fish_seen_subcommand_from help' -a 'cancel' -d 'Show cancel command help'
complete -c c8ctl -n '__fish_seen_subcommand_from help' -a 'resolve' -d 'Show resolve command help'
complete -c c8 -n '__fish_seen_subcommand_from help' -a 'resolve' -d 'Show resolve command help'
complete -c c8ctl -n '__fish_seen_subcommand_from help' -a 'fail' -d 'Show fail command help'
complete -c c8 -n '__fish_seen_subcommand_from help' -a 'fail' -d 'Show fail command help'
complete -c c8ctl -n '__fish_seen_subcommand_from help' -a 'activate' -d 'Show activate command help'
complete -c c8 -n '__fish_seen_subcommand_from help' -a 'activate' -d 'Show activate command help'
complete -c c8ctl -n '__fish_seen_subcommand_from help' -a 'publish' -d 'Show publish command help'
complete -c c8 -n '__fish_seen_subcommand_from help' -a 'publish' -d 'Show publish command help'
complete -c c8ctl -n '__fish_seen_subcommand_from help' -a 'correlate' -d 'Show correlate command help'
complete -c c8 -n '__fish_seen_subcommand_from help' -a 'correlate' -d 'Show correlate command help'
complete -c c8ctl -n '__fish_seen_subcommand_from help' -a 'upgrade' -d 'Show upgrade command help'
complete -c c8 -n '__fish_seen_subcommand_from help' -a 'upgrade' -d 'Show upgrade command help'
complete -c c8ctl -n '__fish_seen_subcommand_from help' -a 'downgrade' -d 'Show downgrade command help'
complete -c c8 -n '__fish_seen_subcommand_from help' -a 'downgrade' -d 'Show downgrade command help'
complete -c c8ctl -n '__fish_seen_subcommand_from help' -a 'init' -d 'Show init command help'
complete -c c8 -n '__fish_seen_subcommand_from help' -a 'init' -d 'Show init command help'
complete -c c8ctl -n '__fish_seen_subcommand_from help' -a 'plugin' -d 'Show plugin management help'
complete -c c8 -n '__fish_seen_subcommand_from help' -a 'plugin' -d 'Show plugin management help'
complete -c c8ctl -n '__fish_seen_subcommand_from help' -a 'plugins' -d 'Alias for plugin management help'
complete -c c8 -n '__fish_seen_subcommand_from help' -a 'plugins' -d 'Alias for plugin management help'
`;
}

/**
 * Show completion command
 */
export function showCompletion(shell?: string): void {
  const logger = getLogger();

  if (!shell) {
    logger.error('Shell type required. Usage: c8 completion <bash|zsh|fish>');
    process.exit(1);
  }

  const normalizedShell = shell.toLowerCase();

  switch (normalizedShell) {
    case 'bash':
      console.log(generateBashCompletion());
      break;
    case 'zsh':
      console.log(generateZshCompletion());
      break;
    case 'fish':
      console.log(generateFishCompletion());
      break;
    default:
      logger.error(`Unknown shell: ${shell}`);
      logger.info('Supported shells: bash, zsh, fish');
      logger.info('Usage: c8 completion <bash|zsh|fish>');
      process.exit(1);
  }
}
