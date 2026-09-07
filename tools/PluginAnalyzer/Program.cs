using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

if (args.Length == 0)
{
    Console.Error.WriteLine("Usage: PluginAnalyzer <path-to.csproj> [solution-root]");
    return 1;
}

var csprojPath   = Path.GetFullPath(args[0]);
var projectDir   = Path.GetDirectoryName(csprojPath)!;
var solutionRoot = args.Length > 1 ? Path.GetFullPath(args[1]) : Path.GetDirectoryName(projectDir)!;

var allFiles     = CollectCsFiles(solutionRoot).ToList();
var projectFiles = new HashSet<string>(CollectCsFiles(projectDir), StringComparer.OrdinalIgnoreCase);

var allTrees = allFiles
    .Select(f => (path: f, tree: (SyntaxTree)CSharpSyntaxTree.ParseText(File.ReadAllText(f))))
    .ToList();

var constMap  = BuildConstMap(allTrees.Select(t => t.tree));
var methodMap = BuildMethodMap(allTrees.Select(t => t.tree), constMap);

var results = new List<PluginResult>();

foreach (var (filePath, tree) in allTrees)
{
    if (!projectFiles.Contains(filePath)) continue;

    foreach (var cls in tree.GetRoot().DescendantNodes().OfType<ClassDeclarationSyntax>())
    {
        var stepAttr = cls.AttributeLists
            .SelectMany(al => al.Attributes)
            .FirstOrDefault(a => { var n = a.Name.ToString(); return n == "PluginStep" || n.EndsWith(".PluginStep"); });

        var customApiAttr = cls.AttributeLists
            .SelectMany(al => al.Attributes)
            .FirstOrDefault(a => { var n = a.Name.ToString(); return n == "CustomApiStep" || n.EndsWith(".CustomApiStep"); });

        if (stepAttr is null && customApiAttr is null) continue;

        var stepInfo       = stepAttr      is not null ? ParsePluginStep(stepAttr, constMap)         : null;
        var customApiInfo  = customApiAttr is not null ? ParseCustomApiStep(customApiAttr, constMap) : null;
        var targetFields   = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var preImageFields = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var method in cls.DescendantNodes().OfType<MethodDeclarationSyntax>())
        {
            foreach (var f in GetAttrArgs(method, "Target",   constMap)) targetFields.Add(f);
            foreach (var f in GetAttrArgs(method, "PreImage", constMap)) preImageFields.Add(f);
        }

        foreach (var inv in cls.DescendantNodes().OfType<InvocationExpressionSyntax>())
        {
            var name = inv.Expression switch
            {
                MemberAccessExpressionSyntax m => m.Name.Identifier.Text,
                IdentifierNameSyntax id        => id.Identifier.Text,
                _                              => null
            };
            if (name is null || !methodMap.TryGetValue(name, out var info)) continue;
            foreach (var f in info.Target)   targetFields.Add(f);
            foreach (var f in info.PreImage) preImageFields.Add(f);
        }

        results.Add(new PluginResult(
            cls.Identifier.Text, stepInfo, customApiInfo,
            targetFields.ToList(), preImageFields.ToList()));
    }
}

Console.WriteLine(JsonSerializer.Serialize(results));
return 0;

// ─── helpers ────────────────────────────────────────────────────────────────

static Dictionary<string, (List<string> Target, List<string> PreImage)> BuildMethodMap(
    IEnumerable<SyntaxTree> trees, Dictionary<string, string> constMap)
{
    var map = new Dictionary<string, (List<string> Target, List<string> PreImage)>();
    foreach (var tree in trees)
    {
        foreach (var method in tree.GetRoot().DescendantNodes().OfType<MethodDeclarationSyntax>())
        {
            var target   = GetAttrArgs(method, "Target",   constMap);
            var preImage = GetAttrArgs(method, "PreImage", constMap);
            if (target.Count == 0 && preImage.Count == 0) continue;

            var key = method.Identifier.Text;
            if (!map.TryGetValue(key, out var entry))
            {
                entry = (new List<string>(), new List<string>());
                map[key] = entry;
            }
            foreach (var f in target)   { if (!entry.Target.Contains(f))   entry.Target.Add(f); }
            foreach (var f in preImage) { if (!entry.PreImage.Contains(f)) entry.PreImage.Add(f); }
        }
    }
    return map;
}

static Dictionary<string, string> BuildConstMap(IEnumerable<SyntaxTree> trees)
{
    var map = new Dictionary<string, string>(StringComparer.Ordinal);
    foreach (var tree in trees)
    {
        foreach (var field in tree.GetRoot().DescendantNodes().OfType<FieldDeclarationSyntax>())
        {
            if (!field.Modifiers.Any(m => m.IsKind(SyntaxKind.ConstKeyword))) continue;
            foreach (var variable in field.Declaration.Variables)
            {
                if (variable.Initializer?.Value is LiteralExpressionSyntax lit &&
                    lit.Token.IsKind(SyntaxKind.StringLiteralToken))
                {
                    var key = QualifiedName(variable);
                    if (!string.IsNullOrEmpty(key)) map[key] = lit.Token.ValueText;
                }
            }
        }
    }
    return map;
}

static string QualifiedName(VariableDeclaratorSyntax variable)
{
    var parts = new List<string> { variable.Identifier.Text };
    Microsoft.CodeAnalysis.SyntaxNode? current = variable.Parent?.Parent;
    while (current is not null)
    {
        if (current is CompilationUnitSyntax) break;
        if (current is BaseTypeDeclarationSyntax type)
            parts.Insert(0, type.Identifier.Text);
        current = current.Parent;
    }
    return parts.Count > 1 ? string.Join(".", parts) : string.Empty;
}

static List<string> GetAttrArgs(MethodDeclarationSyntax method, string attrName, Dictionary<string, string> constMap)
{
    var result = new List<string>();
    foreach (var attrList in method.AttributeLists)
        foreach (var attr in attrList.Attributes)
        {
            var n = attr.Name.ToString();
            if (n != attrName && !n.EndsWith("." + attrName)) continue;
            if (attr.ArgumentList is null) continue;
            foreach (var arg in attr.ArgumentList.Arguments)
                result.Add(ResolveExpr(arg.Expression, constMap));
        }
    return result;
}

static string ResolveExpr(ExpressionSyntax expr, Dictionary<string, string> constMap)
{
    var text = expr.ToString();
    if (constMap.TryGetValue(text, out var resolved)) return resolved;
    if (expr is LiteralExpressionSyntax lit && lit.Token.IsKind(SyntaxKind.StringLiteralToken))
        return lit.Token.ValueText;
    return text;
}

static PluginStepInfo ParsePluginStep(AttributeSyntax attr, Dictionary<string, string> constMap)
{
    var args = attr.ArgumentList?.Arguments.ToList() ?? new List<AttributeArgumentSyntax>();

    static string EnumName(ExpressionSyntax e) => e switch
    {
        MemberAccessExpressionSyntax m => m.Name.Identifier.Text,
        IdentifierNameSyntax id        => id.Identifier.Text,
        _                              => e.ToString()
    };

    var entity  = args.Count > 0 ? ResolveExpr(args[0].Expression, constMap) : "";
    var message = args.Count > 1 ? EnumName(args[1].Expression) : "";
    var stage   = args.Count > 2 ? EnumName(args[2].Expression) : "";
    var isAsync = args.Count > 3 && args[3].Expression.ToString() == "true";
    var order   = 1;
    if (args.Count > 4) int.TryParse(args[4].Expression.ToString(), out order);

    return new PluginStepInfo(entity, message, stage, isAsync, order);
}

static CustomApiStepInfo ParseCustomApiStep(AttributeSyntax attr, Dictionary<string, string> constMap)
{
    var args = attr.ArgumentList?.Arguments.ToList() ?? new List<AttributeArgumentSyntax>();

    var uniqueName  = args.Count > 0 ? ResolveExpr(args[0].Expression, constMap) : "";
    var displayName = args.Count > 1 ? ResolveExpr(args[1].Expression, constMap) : uniqueName;
    var description = args.Count > 2 ? ResolveExpr(args[2].Expression, constMap) : "";

    // allowedStepType: int literal (0/1/2) or enum member name (None/AsyncOnly/SyncAndAsync)
    var stepType = 2;
    if (args.Count > 3)
    {
        var raw = args[3].Expression;
        if (!int.TryParse(raw.ToString(), out stepType))
        {
            var name = raw switch
            {
                MemberAccessExpressionSyntax m => m.Name.Identifier.Text,
                IdentifierNameSyntax id        => id.Identifier.Text,
                _                              => raw.ToString()
            };
            stepType = name switch { "None" => 0, "AsyncOnly" => 1, _ => 2 };
        }
    }

    return new CustomApiStepInfo(uniqueName, displayName, description, stepType);
}

static IEnumerable<string> CollectCsFiles(string dir)
{
    foreach (var entry in Directory.EnumerateFileSystemEntries(dir))
    {
        if (Directory.Exists(entry))
        {
            var name = Path.GetFileName(entry);
            if (name is "obj" or "bin") continue;
            foreach (var f in CollectCsFiles(entry)) yield return f;
        }
        else if (entry.EndsWith(".cs", StringComparison.OrdinalIgnoreCase))
            yield return entry;
    }
}

record PluginStepInfo(
    [property: JsonPropertyName("entityName")] string EntityName,
    [property: JsonPropertyName("message")]    string Message,
    [property: JsonPropertyName("stage")]      string Stage,
    [property: JsonPropertyName("isAsync")]    bool   IsAsync,
    [property: JsonPropertyName("order")]      int    Order
);

record CustomApiStepInfo(
    [property: JsonPropertyName("uniqueName")]      string UniqueName,
    [property: JsonPropertyName("displayName")]     string DisplayName,
    [property: JsonPropertyName("description")]     string Description,
    [property: JsonPropertyName("allowedStepType")] int    AllowedStepType
);

record PluginResult(
    [property: JsonPropertyName("className")]      string             ClassName,
    [property: JsonPropertyName("pluginStep")]     PluginStepInfo?    PluginStep,
    [property: JsonPropertyName("customApiStep")]  CustomApiStepInfo? CustomApiStep,
    [property: JsonPropertyName("targetFields")]   List<string>       TargetFields,
    [property: JsonPropertyName("preImageFields")] List<string>       PreImageFields
);
