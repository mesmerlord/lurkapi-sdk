"""LurkAPI: public social media data as JSON. https://lurkapi.com/docs"""

from ._client import API_URL, LurkAPI, LurkAPIError
from ._version import __version__

__all__ = ["API_URL", "LurkAPI", "LurkAPIError", "__version__"]
