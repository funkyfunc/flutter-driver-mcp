export const getHarnessCode = (packageName?: string) => `
import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:web_socket_channel/io.dart';
${packageName ? `import 'package:${packageName}/main.dart' as app;` : ''}

void main() {
  final binding = IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  binding.framePolicy = LiveTestWidgetsFlutterBindingFramePolicy.fullyLive;

  testWidgets('MCP Pilot Harness', (WidgetTester tester) async {
    ${packageName ? '// Start the app\n    app.main();' : '// No app.main() call injected'}
    
    // Wait for the app to settle initially
    await tester.pumpAndSettle();

    final wsUrl = const String.fromEnvironment('WS_URL', defaultValue: 'ws://localhost:8080');
    print('MCP: Connecting to \$wsUrl');
    
    // Simple retry logic
    IOWebSocketChannel? channel;
    for (var i = 0; i < 5; i++) {
      try {
        channel = IOWebSocketChannel.connect(Uri.parse(wsUrl));
        await channel.ready;
        break;
      } catch (e) {
        print('MCP: Connection failed, retrying in 1s... \$e');
        await Future.delayed(const Duration(seconds: 1));
      }
    }

    if (channel == null) {
      print('MCP: Could not connect to host.');
      return;
    }

    print('MCP: Connected.');
    
    // Notify host we are ready
    channel.sink.add(jsonEncode({
      'jsonrpc': '2.0',
      'method': 'app.started',
      'params': {},
    }));

    await for (final message in channel.stream) {
      print('MCP: Received \$message');
      final map = jsonDecode(message as String) as Map<String, dynamic>;
      final id = map['id'];
      
      // Handle notifications (no id) or requests
      if (id == null) continue;

      final method = map['method'] as String;
      final params = map['params'] as Map<String, dynamic>? ?? {};

      try {
        Object? result;
        switch (method) {
          case 'tap':
            await _handleTap(tester, params);
            break;
          case 'enter_text':
            await _handleEnterText(tester, params);
            break;
          case 'get_widget_tree':
            result = _handleGetWidgetTree(params);
            break;
          case 'scroll':
            await _handleScroll(tester, params);
            break;
          case 'scroll_until_visible':
            await _handleScrollUntilVisible(tester, params);
            break;
          case 'wait_for':
            await _handleWaitFor(tester, params);
            break;
          default:
            throw 'Unknown method: \$method';
        }
        
        channel.sink.add(jsonEncode({
          'jsonrpc': '2.0',
          'id': id,
          'result': result ?? {'status': 'success'},
        }));
      } catch (e, stack) {
        print('MCP: Error: \$e');
        channel.sink.add(jsonEncode({
          'jsonrpc': '2.0',
          'id': id,
          'error': {
            'code': -32000,
            'message': e.toString(),
            'data': stack.toString(),
          },
        }));
      }
    }
  });
}

Finder _createFinder(Map<String, dynamic> params) {
  final finderType = params['finderType'] as String?;
  if (finderType == null) throw 'finderType is required';

  switch (finderType) {
    case 'byKey':
      return find.byKey(Key(params['key'] as String));
    case 'byValueKey':
      final keyVal = params['key'];
      if (keyVal is int) {
         return find.byKey(ValueKey<int>(keyVal));
      }
      return find.byKey(ValueKey<String>(keyVal.toString()));
    case 'byText':
      return find.text(params['text'] as String);
    case 'byTooltip':
      return find.byTooltip(params['tooltip'] as String);
    case 'byType':
      return find.byWidgetPredicate((widget) => widget.runtimeType.toString() == params['type']);
    default:
      throw 'Unsupported finder type: \$finderType';
  }
}

Future<void> _handleTap(WidgetTester tester, Map<String, dynamic> params) async {
  final finder = _createFinder(params);
  await tester.tap(finder);
  await tester.pumpAndSettle();
}

Future<void> _handleEnterText(WidgetTester tester, Map<String, dynamic> params) async {
  final finder = _createFinder(params);
  final text = params['text'] as String;
  await tester.enterText(finder, text);
  await tester.pumpAndSettle();
}

Future<void> _handleScroll(WidgetTester tester, Map<String, dynamic> params) async {
  final finder = _createFinder(params);
  final dx = (params['dx'] as num?)?.toDouble() ?? 0.0;
  final dy = (params['dy'] as num?)?.toDouble() ?? 0.0;
  await tester.drag(finder, Offset(dx, dy));
  await tester.pumpAndSettle();
}

Future<void> _handleScrollUntilVisible(WidgetTester tester, Map<String, dynamic> params) async {
  final finder = _createFinder(params);
  // Default to scrolling down 500px in steps of 50
  final delta = (params['dy'] as num?)?.toDouble() ?? -500.0; 
  final scrollable = params['scrollable'] != null 
      ? _createFinder(params['scrollable']) 
      : find.byType(Scrollable);
      
  await tester.scrollUntilVisible(
    finder,
    50.0, // delta step
    scrollable: scrollable,
    maxScrolls: 50, // Safety limit
  );
  await tester.pumpAndSettle();
}

Future<void> _handleWaitFor(WidgetTester tester, Map<String, dynamic> params) async {
  final finder = _createFinder(params);
  final timeout = Duration(milliseconds: params['timeout'] as int? ?? 5000);
  final end = DateTime.now().add(timeout);
  while (DateTime.now().isBefore(end)) {
    if (finder.evaluate().isNotEmpty) return;
    await tester.pump(const Duration(milliseconds: 100));
  }
  throw 'Timeout waiting for widget';
}

Map<String, dynamic> _handleGetWidgetTree(Map<String, dynamic> params) {
  final root = WidgetsBinding.instance.rootElement;
  if (root == null) return {'error': 'No root element'};
  
  final summaryOnly = params['summaryOnly'] == true;
  return _serializeElement(root, summaryOnly: summaryOnly);
}

Map<String, dynamic> _serializeElement(Element element, {required bool summaryOnly}) {
  final children = <Map<String, dynamic>>[];
  element.visitChildren((child) {
    
    final serializedChild = _serializeElement(child, summaryOnly: summaryOnly);
    if (!summaryOnly || _shouldKeep(serializedChild)) {
       children.add(serializedChild);
    } else if (serializedChild.containsKey('children')) {
       // If the node itself is filtered but has children, promote the children?
       // This effectively removes the wrapper.
       children.addAll((serializedChild['children'] as List).cast<Map<String, dynamic>>());
    }
  });

  final widget = element.widget;
  final type = widget.runtimeType.toString();
  
  final json = <String, dynamic>{
    'type': type,
  };

  if (widget is Text) {
    json['data'] = widget.data;
  } else if (widget is Tooltip) {
    json['message'] = widget.message;
  }
  if (widget.key != null) {
    json['key'] = widget.key.toString();
  }

  if (children.isNotEmpty) {
    json['children'] = children;
  }
  
  return json;
}

bool _shouldKeep(Map<String, dynamic> json) {
  final type = json['type'] as String;
  final hasKey = json.containsKey('key');
  final hasData = json.containsKey('data'); // Text
  final hasMessage = json.containsKey('message'); // Tooltip
  
  if (hasKey || hasData || hasMessage) return true;
  
  // List of widgets to "flatten" (remove from tree but keep children)
  const flattenWidgets = {
    'Container', 'Padding', 'Center', 'SizedBox', 'Align', 'Expanded', 'Flexible', 
    'Column', 'Row', 'Stack', 'ConstrainedBox', 'DecoratedBox', 'SafeArea', 
    'SingleChildScrollView', 'Scrollable', 'GestureDetector', 'InkWell',
    'Semantics', 'ExcludeSemantics', 'MergeSemantics',
    'Material', 'Scaffold', 
    '_ViewScope', '_PipelineOwnerScope', '_MediaQueryFromView', 'MediaQuery', 'FocusTraversalGroup', 'Focus', 
    '_FocusInheritedScope', '_FocusScopeWithExternalFocusNode', '_RawViewInternal', 'RawView', 'View', 'RootWidget'
  };
  
  if (flattenWidgets.contains(type)) return false;
  
  return true;
}
`;