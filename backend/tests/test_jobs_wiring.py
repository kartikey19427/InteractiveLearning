"""The background jobs must be wired to real functions (a missing import once silenced every recording)."""

import inspect

from app import jobs, narration


def test_chapter_narration_job_uses_a_real_function():
    assert jobs.narrate_chapter is narration.narrate_chapter
    assert inspect.iscoroutinefunction(jobs._narrate_chapter)


def test_every_name_the_jobs_module_uses_is_defined():
    import ast
    import builtins

    tree = ast.parse(inspect.getsource(jobs))
    defined = set(dir(builtins)) | set(dir(jobs))
    local = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            local.add(node.name)
            local |= {a.arg for a in node.args.args + node.args.kwonlyargs + node.args.posonlyargs}
            local |= {a.arg for a in (node.args.vararg, node.args.kwarg) if a}
        elif isinstance(node, ast.Name) and isinstance(node.ctx, ast.Store):
            local.add(node.id)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            local |= {(a.asname or a.name).split(".")[0] for a in node.names}
        elif isinstance(node, ast.ExceptHandler) and node.name:
            local.add(node.name)
        elif isinstance(node, ast.comprehension):
            for n in ast.walk(node.target):
                if isinstance(n, ast.Name):
                    local.add(n.id)
    used = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Load)}
    assert sorted(used - defined - local) == []
