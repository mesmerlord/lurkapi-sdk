"""The stub generator on a small spec. The repo's shared/__tests__/sdk.test.ts runs it on the real registry."""

import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("generate", Path(__file__).resolve().parent.parent / "scripts/generate.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
generate = module.generate


def op(**more):
    return {
        "operationId": "demo_echo_back",
        "summary": "Echo",
        "description": 'Says it """back""".\n\nMore.\n\nCost: 1 credit.',
        "externalDocs": {"url": "https://lurkapi.com/docs/demo/echo-back"},
        "parameters": [
            {"name": "trim", "in": "query", "required": False, "schema": {"type": "string", "enum": ["true", "false"]}},
            {"name": "sort", "in": "query", "required": False, "schema": {"type": "string", "enum": ["new", "top"]}},
            {"name": "count", "in": "query", "required": False, "schema": {"type": "integer"}},
            {"name": "query", "in": "query", "required": True, "description": "What to say.", "schema": {"type": "string"}},
        ],
        **more,
    }


class GenerateTest(unittest.TestCase):
    def test_an_operation_becomes_a_method_with_keyword_parameters(self):
        code = generate({"paths": {"/v2/demo/echo": {"get": op()}}}, "test")
        compile(code, "_operations.pyi", "exec")
        self.assertIn('def echo_back(self, *, query: str, trim: bool | None = None, sort: Literal["new", "top"] | None = None, count: int | None = None) -> dict[str, Any]:', code)
        self.assertIn("\"\"\"Echo. Says it '''back'''. Cost: 1 credit. https://lurkapi.com/docs/demo/echo-back", code)
        self.assertIn("        query: What to say.\n", code)
        self.assertIn("class Operations:\n    demo: _Demo\n", code)

    def test_no_parameters_and_a_name_python_reserves(self):
        bare = generate({"paths": {"/v1/a": {"get": op(parameters=[])}}}, "test")
        self.assertIn("def echo_back(self) -> dict[str, Any]:", bare)
        reserved = generate({"paths": {"/v1/a": {"get": op(parameters=[{"name": "from", "in": "query", "schema": {"type": "string"}}, {"name": "q", "in": "query", "schema": {"type": "string"}}])}}}, "test")
        compile(reserved, "_operations.pyi", "exec")
        self.assertIn("def echo_back(self, *, q: str | None = None, **more: Any) -> dict[str, Any]:", reserved)

    def test_it_stops_on_what_the_clients_dont_assume(self):
        for paths, why in [
            ({"/v1/a": {"get": op(), "post": op()}}, "isn't GET only"),
            ({"/v1/a/{id}": {"get": op()}}, "path parameter"),
            ({"/v1/a": {"get": op(operationId="Echo")}}, "operationId"),
            ({"/v1/a": {"get": op(parameters=[{"name": "id", "in": "path", "schema": {"type": "string"}}])}}, "isn't a query parameter"),
            ({"/v1/a": {"get": op(parameters=[{"name": "ids", "in": "query", "schema": {"type": "array"}}])}}, "unknown parameter type"),
        ]:
            with self.assertRaisesRegex(ValueError, why):
                generate({"paths": paths}, "test")


if __name__ == "__main__":
    unittest.main()
